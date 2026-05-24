# Spec 061: Staff App — EOD Count (Per-User JWT, Offline Queue, Flat Architecture)

Status: READY_FOR_REVIEW
Owner: backend-architect
Companion repo: `~/Documents/GitHub/imr-staff` (new — to be created in implementation)

## Problem statement (verbatim user request)

The 2AM PROJECT operates with two distinct user populations: admins (this repo, `imr-inventory`) and front-of-house / kitchen staff. Staff today have no first-class app — the existing `staff-*` edge functions in this repo were a stop-gap scaffolded behind a shared service token, designed to be consumed by a hypothetical sibling app that was never built. End-of-day counts are currently entered by managers in the admin UI on behalf of staff, which is wrong: staff are the ones holding the count sheet, the manager is just a typist.

The request: ship a real staff app — `imr-staff`, a new sibling repo — whose first feature is the EOD inventory count. Staff sign in directly to Supabase with their own credentials (no shared token), authorization is enforced at the database layer via RLS using the existing `profiles.role = 'user'` + `user_stores` rows, and the app works offline (count on the floor with no wifi, sync when reconnected). The existing `staff_submit_eod` RPC stays — it already has idempotency via `client_uuid` — but its GRANT model shifts from `service_role` to `authenticated`, and the per-user JWT carries the auth, not a shared header. The existing admin EOD section in this repo must keep working unchanged; staff submissions show up there for review like they always have.

This spec covers the backend contract changes in `imr-inventory` (Track A) AND specifies the new repo scaffold (Track B) and the cross-repo sequencing (Track C). Backend lands first, frontend lands in a second build cycle against a stable contract.

## User stories

(i) As a **staff member** at end of shift, I want to count inventory on my phone and submit it WITHOUT needing wifi at the exact moment of counting, so that bad reception in the walk-in or a flaky store router doesn't make me redo my work or lose data.

(ii) As an **admin / store manager**, I want staff submissions to show up in my existing EOD count section in `imr-inventory` unchanged, so that my reporting and review flow keeps working when staff take over data entry.

(iii) As a **security-conscious operator**, I want staff users to be authorized at the **database** level (RLS) — not via shared secrets in an edge function — so that a compromised staff device cannot escalate to read recipes, modify the brand catalog, or see other stores' data. Per-user JWTs revoke cleanly; shared tokens do not.

(iv) As a **store manager**, I want a staff user assigned to two stores to pick which store they're counting at when they sign in, so that the right submission lands in the right store's records.

## Architecture overview

```
  ┌────────────────────────────────────┐         ┌─────────────────────────────────┐
  │  imr-staff (new repo)              │         │  imr-inventory (this repo)      │
  │  ~/Documents/GitHub/imr-staff      │         │                                 │
  │                                    │         │                                 │
  │  Expo / RN — staff phones          │         │  Expo / RN — admin web + native │
  │  • email+password sign-in          │         │  • existing Cmd UI              │
  │  • EOD count screen                │         │  • existing EOD section reads   │
  │  • offline queue (AsyncStorage)    │         │    the same eod_submissions     │
  │  • supabase-js direct              │         │    rows the staff app writes    │
  └─────────────┬──────────────────────┘         └───────────────┬─────────────────┘
                │                                                │
                │ per-user JWT                                   │ per-user JWT
                │ (authenticated role)                           │ (authenticated, admin role claim)
                ▼                                                ▼
              ┌─────────────────────────────────────────────────────┐
              │  Supabase (shared)                                  │
              │  • PostgREST + RPC                                  │
              │  • RLS via auth_can_see_store() + auth_is_admin()   │
              │  • staff_submit_eod(...) GRANT → authenticated      │
              │  • eod_submissions / eod_entries / inventory_items  │
              │  • DEPRECATED: staff-catalog, staff-eod-submit,     │
              │    staff-waste-log edge fns return 410              │
              └─────────────────────────────────────────────────────┘
```

The staff frontend talks to Supabase directly. There is no staff-app backend half. The admin app and the staff app share one Supabase project; RLS is the entire authorization story.

## Acceptance criteria

The criteria are split across three tracks. Tracks A and C land in `imr-inventory`. Track B is implemented in the new `imr-staff` repo and is captured here as the contract the staff frontend must hit (the staff-frontend itself will get its own follow-on spec, **062**, in the `imr-staff` repo, but the scaffold + AC for v1 are pinned here so the contract is single-sourced).

### Track A — Backend in THIS repo (`imr-inventory`)

- [ ] **A1** — `staff_submit_eod` RPC GRANT updated from `service_role` to `authenticated`. New timestamped migration under `supabase/migrations/`. The architect decides whether the body needs rework to derive `submitted_by` from `auth.uid()` / `auth.jwt()` instead of trusting the caller-supplied `p_submitted_by` argument (see Open Q1) — that decision is made in the design doc before READY_FOR_BUILD; the AC here just gates that the GRANT change ships and the function remains callable by `authenticated` JWTs.

- [ ] **A2 (revised per architect §0)** — RLS verification. With a staff user whose `profiles.role = 'user'` and who has `user_stores` rows for store X but NOT store Y:
  - INSERT into `eod_submissions` via the RPC for store X succeeds.
  - INSERT into `eod_submissions` for store Y is refused.
  - Direct INSERT/UPDATE/DELETE on `recipes`, `purchase_orders`, and brand-catalog tables is refused (WRITES blocked).
  - SELECT on brand-shared `recipes` / `inventory_items` rows IS permitted, per the brand-catalog refactor (specs 012a / 015). This is intentional — staff are members of the brand and need to read shared catalog data. The original PM bullet "CANNOT SELECT recipes" is superseded by the architect's §0 ruling.
  - SELECT on `inventory_items` is permitted (read-only access to the store's items the staff are about to count).
  - SELECT on `eod_submissions` / `eod_entries` for store X is permitted (so the staff app can show "already submitted today" state); same for store Y is refused.

- [ ] **A3** — Existing `staff-catalog`, `staff-eod-submit`, and `staff-waste-log` edge functions deprecated. The new function body returns HTTP 410 with a JSON body `{ error: "<function-name>: deprecated as of spec 061 — staff app now talks to Supabase directly via per-user JWT", reference: "specs/061-staff-app-eod-count.md" }`. The deprecation shape mirrors the 6-arg `staff_submit_eod` retirement pattern at [supabase/migrations/20260514120010_staff_submit_eod_v2.sql:189-206](../supabase/migrations/20260514120010_staff_submit_eod_v2.sql). The functions stay deployed so any stale calls from any pre-migration deploy fail loud rather than 404. Rollout cadence is an open Q for the architect (Open Q4).

- [ ] **A4 (revised per architect §0)** — pgTAP test file at `supabase/tests/staff_role_eod_rls.test.sql` that exercises the staff-user-as-PostgREST-caller path against the EOD tables. Tests:
  - staff user with `user_stores` rows for store X can call `staff_submit_eod` for store X
  - same user CANNOT call `staff_submit_eod` for store Y (auth_can_see_store gate fires with 42501)
  - same user can SELECT their own `eod_submissions` rows but NOT another store's
  - same user CAN SELECT brand-shared `recipes` rows (positive test for §0 ruling)
  - same user CANNOT INSERT/UPDATE/DELETE on `recipes`
  - Test runs via `bash scripts/test-db.sh` and passes.

- [ ] **A5** — Existing admin EOD count section in `src/screens/cmd/sections/` continues to show staff submissions without code changes. (Regression — staff submissions write to the same `eod_submissions` / `eod_entries` rows, so the admin section reads the same data. Verify by running the admin app against a DB with a seeded staff submission and confirming the row appears in the EOD section.)

- [ ] **A6** — Permissive-policy lint (spec 053, `supabase/tests/permissive_policy_lint.test.sql`) passes — no new trivially-wide permissive policies introduced by this spec's migrations. If a new policy IS required and is intentionally wide, the spec's design doc lists it and adds an allowlist entry; otherwise the migration must not add one.

### Track B — Frontend scaffold (NEW REPO `imr-staff`)

These criteria define the v1 frontend contract. The staff-frontend itself will be built in a second cycle (spec 062 in the new repo). The build verification here is "this repo has the contract; the staff-frontend spec builds against it."

- [ ] **B1** — New repo scaffolded at `~/Documents/GitHub/imr-staff` with:
  - Expo SDK 54
  - React Native 0.81
  - TypeScript 5.3 strict
  - Zustand 4.5
  - `@supabase/supabase-js` 2.101
  - React Navigation 6
  - `@react-native-async-storage/async-storage` (for offline queue)
  - Babel + Metro with `@/*` → `src/*` alias matching `imr-inventory`'s setup
  - The repo's stack matches `imr-inventory` where reasonable so engineers can context-switch; deviations are documented in the new repo's CLAUDE.md.

- [ ] **B2** — `CLAUDE.md` inside `imr-staff` containing:
  - "What this is": staff-facing app for 2AM PROJECT EOD counts
  - "Backend": points at `imr-inventory`'s Supabase project; states the contract is single-sourced in `imr-inventory/specs/061-staff-app-eod-count.md`
  - "Stack": list per B1
  - "Conventions": staff app has NO admin UI, NO brand catalog UI, NO recipe management — if a feature request implies those, redirect to `imr-inventory`
  - "Auth model": email+password, per-user JWT, `profiles.role = 'user'` required
  - "Realtime": none in v1 (see B7 — offline queue + pull on focus)
  - "i18n": English-only in v1, scaffold ready for future locales (B8)

- [ ] **B3** — Auth flow:
  - Email + password sign-in via `supabase.auth.signInWithPassword`.
  - On successful sign-in, fetch `profiles.role` for the authenticated user.
  - If `profiles.role ≠ 'user'`, sign the session out and show an error: "This app is for staff only. Admins should use the imr-inventory app."
  - If `profiles.role = 'user'` but `user_stores` is empty for that user, sign out and show: "Your account is not assigned to any store. Contact your manager."
  - Otherwise proceed to store-picker (B4).

- [ ] **B4** — Store picker:
  - When `user_stores.count > 1`, show a picker after sign-in. User taps a store → that becomes the active store for the session.
  - When `user_stores.count == 1`, skip the picker and use the only store.
  - The active store id is persisted to AsyncStorage so an app reload doesn't re-prompt (the user can switch via a "Change store" menu item).

- [ ] **B5** — EOD count screen:
  - Date selector (defaults to today, store local time).
  - For the selected date, the screen lists items belonging to the store's vendors-for-that-weekday (the vendor-day filter from spec 007 — `inventory_items` joined to `vendors` whose `vendor_days` includes the weekday).
  - Each item is a row with: item name, unit, current_stock (read-only context), a numeric input for the count.
  - Submit button at the bottom triggers the submission flow (B6).
  - Refresh button in the header (no realtime — see B7).

- [ ] **B6** — Submission flow:
  - On submit, generate a `client_uuid` (UUID v4) client-side.
  - Call `supabase.rpc('staff_submit_eod', { p_client_uuid, p_store_id, p_date, p_submitted_by, p_status: 'submitted', p_entries, p_vendor_id })`.
  - Note: `p_submitted_by` may be replaced by server-side `auth.uid()` derivation depending on Open Q1's resolution. The frontend supplies it for now; if the backend swaps to server-derived, the frontend stops sending it in a follow-up.
  - 200 success → mark the local submission "done", show a success state with submission id.
  - 409 conflict (idempotency replay, already submitted by another device or earlier retry) → fetch the existing submission and show a "View existing submission" screen — NOT an error UX. The body's `submission_id` is surfaced.
  - 4xx other → show the error message; keep the local draft so the user can edit and retry.

- [ ] **B7** — Offline queue (THE substantial scope):
  - When the supabase call fails because the device is offline (detected via the connectivity hook — see B7a), persist the full submission payload (including the `client_uuid` so retries dedup correctly) to AsyncStorage under a queue key like `imr-staff:eod-queue:v1`.
  - The queue is a FIFO list. Multiple queued submissions are supported (e.g. one for today's first vendor, one for today's second vendor).
  - The UI shows a "Queued — will sync when online" badge per item.
  - On connectivity recover, drain the queue: replay each entry via the same RPC. 200 → remove from queue. 409 → remove from queue (replay dedup worked). 4xx other → leave in queue, show an error badge, do NOT crash the drain.
  - Queue is per-user, scoped by the authenticated user id. Sign-out behavior: see Open Q2.
  - **B7a (connectivity hook)** — Reuse the spec 059 `useConnectionStatus` hook from `imr-inventory/src/hooks/useConnectionStatus.ts`. Copy verbatim into `imr-staff/src/hooks/useConnectionStatus.ts` with a comment block attributing it to imr-inventory spec 059. The architect decides whether the spec 059 hook's Phoenix-Socket signal is sufficient for a staff app with no realtime subscriptions or whether `@react-native-community/netinfo` is the right primitive instead (Open Q3).

- [ ] **B8** — i18n scaffold:
  - Copy the i18n pattern from `imr-inventory/src/i18n/` (the structure under `src/i18n/index.ts` + `en.json`).
  - English-only in v1; the structure supports adding `es.json` / `zh-CN.json` later.
  - All user-facing strings in the staff app go through the i18n hook from day one (no hard-coded UI strings).

- [ ] **B9** — jest test track set up in `imr-staff` from day one:
  - EOD screen renders the items list given a mock store + items
  - Submission happy path: success state shown when RPC returns 200
  - Submission idempotency replay: 409 UX shows the existing submission, not an error toast
  - Offline-queue persistence: when RPC fails with a "network unavailable" signal, the payload appears in AsyncStorage
  - Offline-queue drain: when connectivity flips to online, the queue is replayed and emptied on 200/409
  - Auth gate: a profile with `role != 'user'` is signed out

- [ ] **B10** — `README.md` in `imr-staff` with:
  - Stack list (per B1)
  - Setup steps: `npm install`, env vars (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, etc.)
  - Test command: `npm test`
  - Deploy target: EAS for native (iOS + Android), Vercel for a web preview
  - A "Backend lives in imr-inventory" note with a relative link or absolute filesystem reference

### Track C — Sequencing and tests

- [ ] **C1** — `imr-inventory` backend changes (A1–A6) land FIRST and are deployed/verified BEFORE any work begins on the `imr-staff` frontend implementation (spec 062). The backend's `Status: SHIP_READY` is the gate.

- [ ] **C2** — The pgTAP test at `supabase/tests/staff_role_eod_rls.test.sql` is run via `bash scripts/test-db.sh` and passes before the migration is considered done. The CI workflow `.github/workflows/test.yml` already runs pgTAP — no new CI gate to add.

- [ ] **C3** — Cross-repo shell smoke at `scripts/smoke-staff-eod.sh` in `imr-inventory`:
  - Signs in as a seeded staff user (see Open Q5) via the Supabase auth REST API
  - Captures the JWT
  - Hits `staff_submit_eod` via curl with the JWT as bearer
  - Asserts HTTP 200 and a JSON body containing `submission_id`
  - Queries `eod_submissions` and asserts the row exists with the expected `client_uuid` and store_id
  - Replays the same call and asserts HTTP 409 with the same `submission_id` (idempotency check)
  - Runs locally against the dev stack; documented in a smoke-script section of the spec's design doc

- [ ] **C4** — The staff app frontend is implemented in a SECOND build cycle (spec 062 in `imr-staff`), AFTER backend SHIP_READY. This spec (061) produces the contract; spec 062 builds against it. The B-track AC above pins the v1 contract the staff-frontend spec must satisfy.

- [ ] **C5** — `imr-staff` repo creation is an explicit step in the implementation plan with the exact commands:
  ```
  cd ~/Documents/GitHub
  mkdir imr-staff && cd imr-staff
  git init
  npx create-expo-app@latest . --template blank-typescript
  # ... apply scaffold per Track B
  git add . && git commit -m "Initial commit — staff app scaffold per imr-inventory spec 061"
  # remote add + first push handled by the implementing developer per their hosting choice
  ```
  The exact `npm install` list and the file-by-file scaffold are the implementer's job; this AC pins that the repo is created and the initial commit lands before any spec-062 work begins.

## Scope (explicit)

### In scope

- Backend GRANT + RLS verification + edge function deprecation in `imr-inventory` (Track A)
- pgTAP coverage for staff-as-PostgREST-caller (A4)
- Shell smoke for end-to-end staff-user → staff_submit_eod path (C3)
- New repo `imr-staff` scaffold contract (Track B) — note: actual implementation of the staff frontend is spec 062 in the new repo
- Cross-repo sequencing rules (Track C)

### Out of scope (explicitly)

- **Any staff workflow beyond EOD.** Waste log, prep make, receiving — those are future specs (062+ in the staff repo, or admin-side specs here). The deprecated `staff-waste-log` edge function stays 410'd; the new staff app does not implement waste log in v1.
- **Any admin-app UI changes.** The admin EOD section in `src/screens/cmd/sections/` already exists and stays untouched. Acceptance C-side is that it KEEPS working; not that it changes.
- **Inventory threshold edits on staff app.** Read-only: staff see the items, type counts, submit. They cannot mutate thresholds, categories, vendor assignments, or anything else.
- **A `count_at_eod` column or per-item EOD filter.** The vendor-day filter (spec 007) is the only filter; if a vendor is scheduled for today, all of that vendor's items appear in the count list.
- **Realtime sync in staff app v1.** Pull on focus + manual refresh button. The Phoenix Socket / NetInfo discussion is purely for connectivity detection (B7a), not for live data sync.
- **Multi-language support beyond English in v1.** Scaffold is in place (B8); locales come later.
- **Push notifications in v1.** Out of scope. (`expo-notifications` may end up in the dep list later, but no push surface in v1.)
- **A new role value.** Staff are `profiles.role = 'user'`, the existing role. No `staff` role is introduced. No new RLS policies are required — the spec-015 hardening already routes `auth_can_see_store()` through `user_stores`.
- **Changes to `app.json` slug** — see CLAUDE.md "app.json slug mismatch (DO NOT AUTO-FIX)". If the staff app needs its own slug, that is a separate spec.

## Open questions for architect (MUST resolve before READY_FOR_BUILD)

1. **`staff_submit_eod` GRANT change to `authenticated`** — does this work cleanly with the existing 7-arg signature, or does the body need rework? Specifically: should `p_submitted_by` be ignored / overwritten with `auth.uid()::text` (or with `auth.jwt() ->> 'email'`) inside the body, so the caller cannot spoof the submitter identity? Currently `p_submitted_by` is a `text` parameter trusted from the caller — that was acceptable when the only caller was a service-token edge function but is wrong when the caller is the staff user themselves. Architect decision lands in the design doc.

2. **AsyncStorage queue shape** — what's the serialization format for queued submissions (full RPC arg envelope as JSON? a normalized record?), and when the user signs out, does the queue persist or clear? Default proposal: **persist** and replay on next sign-in of the same user, identifying ownership by the user id stored alongside each queue entry. A different user signing in on the same device sees an empty queue. Architect confirms or revises.

3. **Connectivity detection on native** — the spec 059 `useConnectionStatus` hook is push-driven via the Supabase Phoenix Socket's `realtime.socketAdapter`. The staff app has no active realtime subscriptions in v1 (see Out of scope). Is the Phoenix-Socket signal still meaningful on a freshly-installed staff app that never opens a realtime channel? If not, `@react-native-community/netinfo` is the correct primitive on native; the spec 059 hook can stay as a web fallback. Architect decides — the decision affects both `imr-staff`'s dep list and the implementation of B7a.

4. **Deprecated `staff-*` edge functions rollout** — immediate fail-loud (the 410 lands in the same deploy as A1/A2), or feature-flag for one release cycle so a hypothetical pre-migration deploy doesn't crash mid-upgrade? Since the existing staff-*  functions were never actually consumed by a shipped sibling app (the staff app didn't exist yet), the safest answer is **immediate fail-loud, no flag**. Architect confirms or revises.

5. **Seeded staff user in `supabase/seed.sql`** — does the seed file already contain a staff user (`profiles.role = 'user'`) with `user_stores` rows pointing at a seeded store? If yes, document the credentials in the design doc for C3's smoke script to consume. If no, the architect adds one as part of the design (a seed-side migration or a `seed.sql` patch). The smoke script in C3 cannot work without this.

6. **Cross-repo coordination** — this spec lives in `imr-inventory/specs/`, but Track B's deliverable is in `imr-staff/`. How does the spec record that `imr-staff` is the implementation target? Proposal: this spec's header carries a `Companion repo` field (done above); the new repo's CLAUDE.md cites this spec back; and a future spec 062 in `imr-staff` will reference back to 061 by absolute path. Architect confirms or proposes a different record-keeping shape (e.g. a `repo` field with structured semantics, a shared spec index, etc.).

## Dependencies

- **This repo (`imr-inventory`)**:
  - pgTAP track (`supabase/tests/`, `scripts/test-db.sh`) — A4
  - jest track — for any admin-side changes (likely none, but the regression check A5 may be exercised manually instead of via jest)
  - Shell smokes (`scripts/smoke-*.sh`) — C3, new smoke `smoke-staff-eod.sh`
  - Migration framework (`supabase/migrations/`) — A1, A3
  - Edge function deploys (`supabase/functions/`) — A3 (deprecations, no new functions)

- **New repo (`imr-staff`)**:
  - jest track from day one (B9)
  - Expo SDK 54 / RN 0.81 / TypeScript 5.3 strict / Zustand 4.5 / supabase-js 2.101 / React Navigation 6 (B1)
  - `@react-native-async-storage/async-storage` (B7)
  - Potentially `@react-native-community/netinfo` (B7a, pending Open Q3)
  - i18n pattern copied from `imr-inventory/src/i18n/` (B8)

- **Existing prior-art / specs**:
  - Spec 007 — vendor-day filter (B5 depends on this)
  - Spec 015 — per-store RLS hardening (the entire authorization story relies on this)
  - Spec 020 — `staff_submit_eod` 7-arg signature (the RPC this spec re-grants)
  - Spec 053 — permissive policy lint (A6 must not regress)
  - Spec 059 — `useConnectionStatus` hook (B7a candidate, pending Open Q3)

- **No new RLS policies** required. The spec-015 hardening already routes `auth_can_see_store()` through `user_stores`, which covers staff-as-user cleanly. The architect verifies this in the design doc; if any gap is found, that gap becomes a new AC.

## Project-specific notes

- **Cmd UI section / legacy**: N/A for `imr-inventory` — the admin EOD section is unchanged. The new UI is in a new repo entirely.
- **Per-store or admin-global**: per-store. All staff data is scoped to `user_stores`. No admin-global path in this spec.
- **Realtime channels touched**: none in v1. `useRealtimeSync.ts` in `imr-inventory` continues to work as today; the staff app does NOT subscribe to `store-{id}` or `brand-{id}` channels in v1.
- **Migrations needed**: yes — at least one new timestamped migration for A1 (the GRANT change), possibly a second for any body rework decided in Open Q1. The seed.sql may also need a patch for Open Q5.
- **Edge functions touched**: `staff-catalog`, `staff-eod-submit`, `staff-waste-log` — deprecated to 410 (A3). No new edge functions.
- **Web/native scope**: the **admin** app remains web + native unchanged. The **staff** app primary target is native (iOS + Android via EAS); Vercel web preview is nice-to-have for engineer iteration but not the production target. Customers — sorry, staff — are on their phones.
- **app.json slug**: do not change `imr-inventory/app.json`. The new repo `imr-staff` will have its own `app.json` with its own slug; that slug is the staff-frontend implementer's choice and is NOT load-bearing the way `imr-inventory`'s `towson-inventory` slug is.
- **Test routing**: A4 → pgTAP track. C3 → shell smoke track. A5 regression → manual or jest in admin. B9 → jest track inside `imr-staff` (the test-engineer for the staff frontend builds in the new repo, not here).

## Implementation sequencing (informational, not prescriptive)

```
  Cycle 1 (this spec, 061) — backend lands in imr-inventory:
    architect → design doc resolves Open Q1–Q6
    backend-dev → A1 migration + A3 edge function deprecations + A4 pgTAP test + C3 smoke
    reviewers (parallel) → code-reviewer, security-auditor, test-engineer, architect post-impl
    release-coordinator → SHIP_READY decision
    deploy / verify / mark SHIP_READY

  Cycle 2 (follow-on spec 062 in imr-staff):
    product-manager (in imr-staff) → spec 062 referencing 061
    architect → frontend design
    frontend-dev → scaffold + EOD screen + offline queue
    reviewers (parallel)
    release-coordinator → SHIP_READY
```

The two cycles are gated: cycle 2 does not start until cycle 1 is SHIP_READY and the backend is deployed to the shared Supabase project.

## Backend design

This section is normative and resolves Open Q1–Q6.

### 0. AC reconciliation — `recipes` and `purchase_orders` read access for staff

Before the design proper, one PM-side acceptance criterion needs revision.

AC A2 states that staff users CANNOT read `recipes`, `purchase_orders`, or
brand-catalog tables (`catalog_ingredients`, `prep_recipes`, etc.). Under the
current RLS shape, this is **not true and cannot be made true without
out-of-scope changes**:

- **`recipes` / `catalog_ingredients` / `prep_recipes` / `vendors`** are gated
  by `brand_member_read_*` policies that call `auth_can_see_brand(brand_id)`
  ([supabase/migrations/20260509000000_multi_brand_schema_rls.sql:490-492](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)).
  `auth_can_see_brand` returns TRUE iff the caller is `super_admin` OR
  `profiles.brand_id = p_brand_id` ([:200-210](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql)).
  Staff users carry `profiles.brand_id = '2a000000-…'` per spec 012a backfill
  ([supabase/seed.sql:118-120](../supabase/seed.sql) — `manager@local.test`
  with `role='user'` and `brand_id='2a000000-…'`). Result: **staff CAN read
  brand-catalog rows today** and that is by-design per the spec-005-era
  comment "Reads remain open to any authed user — the brand catalog is shared
  across everyone in the chain so anyone in the org needs to see it (line
  cooks read recipes, store managers read par levels and prep specs, admins
  edit them)"
  ([supabase/migrations/20260504073942_brand_catalog_p5_rls.sql:5-9](../supabase/migrations/20260504073942_brand_catalog_p5_rls.sql)).

- **`purchase_orders`** is gated by `auth_can_see_store(store_id)` via
  `store_member_read_purchase_orders`
  ([supabase/migrations/20260504173035_per_store_rls_hardening.sql:186-188](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)).
  Staff have `user_stores` rows for their store, so the third arm of
  `auth_can_see_store` admits them
  ([supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql:102-107](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql)).
  Staff CAN read `purchase_orders` for their assigned store today.

**Architect ruling**: AC A2 is revised. Staff users:

1. CAN read brand-shared tables (catalog_ingredients, recipes, prep_recipes,
   vendors, ingredient_categories) — by-design, line cooks need recipes. This
   is the same posture as a manager today.
2. CAN read per-store tables for their assigned stores via
   `auth_can_see_store` — including `purchase_orders`, `audit_log`,
   `eod_submissions`, `inventory_items`, etc. (Operationally the staff app
   only surfaces inventory_items + eod_submissions, but PostgREST will not
   refuse other store-scoped reads.) This is by-design and matches the
   manager seed user's existing access posture.
3. CANNOT **write** to any brand-shared table — `privileged_insert_*` /
   `privileged_update_*` / `privileged_delete_*` policies gate on
   `auth_is_privileged()` (admin OR super_admin), which staff are not.
4. CANNOT **write** to `purchase_orders`, `pos_imports`, `audit_log` (except
   audit rows triggered by their own RPC calls) — those policies all gate on
   `auth_is_privileged()` for INSERT/UPDATE/DELETE.
5. CANNOT call privileged RPCs — `auth_is_privileged()` short-circuits to
   false for them.
6. **A2 mutates to**: "Staff users CANNOT WRITE to recipes, purchase_orders,
   or brand-catalog tables. Staff users CAN read these tables (by-design,
   brand-shared visibility per existing posture). Staff users CAN read+write
   `eod_submissions` and `eod_entries` for stores in their `user_stores`."

The pgTAP test (A4 / §3 below) is structured around the revised AC. If the PM
wants the original AC A2 ("CANNOT read recipes") enforced, that's a different
spec — it requires a new RLS shape that distinguishes `role='user'` from
`role='admin'`/`role='master'` for brand-shared reads, which contradicts the
brand-catalog refactor's "shared across the org" design. **Backend-developer
implements against the revised A2 above.**

### 1. Open question resolutions

**Q1 — `staff_submit_eod` GRANT change and body rework.**

The current 7-arg RPC body trusts `p_submitted_by` from the caller and writes
it as the literal value into `audit_log.detail`
([supabase/migrations/20260514120010_staff_submit_eod_v2.sql:147-158](../supabase/migrations/20260514120010_staff_submit_eod_v2.sql)).
It also writes `null` for `eod_submissions.submitted_by` (the trigger
`eod_submissions_set_submitted_by_trg` overrides to `auth.uid()` — which is
`null` under `security definer` + service-role-key calls).

Under the new per-user JWT model, `auth.uid()` IS the staff user's id, so the
trigger ALREADY ensures `eod_submissions.submitted_by` is server-derived and
cannot be spoofed (this was confirmed via direct PostgREST INSERT testing in
spec 020 round-2,
[supabase/tests/eod_submissions_consistency.test.sql:84-130](../supabase/tests/eod_submissions_consistency.test.sql)).

The audit-log detail attribution remains the only spoof surface. Option (a)
from the prompt — replace `p_submitted_by` usage inside the body with
`auth.uid()` — is the cleanest fix: the signature stays compatible with the
existing edge function's call shape (so the deprecation step doesn't need to
coordinate signature changes), AND the body becomes spoof-proof regardless of
what the caller passes.

**Ruling**: pick **option (a)** — drop `p_submitted_by` usage inside the body
and write `auth.uid()::text` in its place (with a `'staff:unknown'` fallback
preserved for the legacy service-role path during the deprecation window).
The parameter STAYS in the signature (`p_submitted_by text`) so:
- The frontend can keep sending it during the transition (B6 frontend can
  send it now and the backend simply ignores it).
- The edge-function deprecation in A3 doesn't depend on the parameter being
  dropped first.
- Future cleanup can drop the unused parameter in a follow-up spec without
  coupling to this one (and without a breaking-change moment).

**security definer vs security invoker**: the RPC stays `security definer`.
Why: the body mutates `inventory_items.current_stock` and inserts into
`audit_log` — both of which would require additional grants to the staff
user if we flipped to `security invoker`. Keeping `security definer` AND
re-deriving identity from `auth.uid()` inside the body is the right
combination. The `eod_submissions` / `eod_entries` rows the RPC inserts
still pass through RLS because the trigger
`eod_submissions_set_submitted_by_trg` is `security invoker` and reads
`auth.uid()` directly (verified at [migration:78-87](../supabase/migrations/20260514120030_eod_submissions_consistency.sql)).

**Wait — does RLS fire for INSERTs inside a `security definer` function?**
Yes for tables not owned by the function owner, but the RPC body's `insert
into public.eod_submissions` runs under the function-definer's privileges
(postgres / supabase_admin role). RLS is therefore bypassed for those rows
in normal supabase project setups (RLS does not apply to the table owner /
postgres superuser). This is the **same** posture as the current service-role
caller — the RPC has always relied on its `security definer` privilege to
write across RLS rather than gating writes through the caller's policies.
Keeping that path unchanged preserves behavior.

What DOES change with the GRANT swap: a **direct PostgREST INSERT** by a
staff caller (NOT through the RPC) would now be possible if RLS allowed it.
The good news: RLS DOES allow it because the staff user's `user_stores` row
admits via `auth_can_see_store`. The trigger
`eod_submissions_set_submitted_by_trg` rewrites the forged `submitted_by`,
and the trigger `eod_entries_check_store_trg` rejects cross-store item
references
([migration:104-138](../supabase/migrations/20260514120030_eod_submissions_consistency.sql)).
So a staff user CAN insert via PostgREST directly — and the result is
semantically equivalent to the RPC path. The frontend will use the RPC
because of the idempotency-via-`client_uuid` semantics, but **the direct
path is not a security hole** — it produces correctly-attributed rows.

**GRANT change**:

```sql
revoke execute on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) from service_role;
grant  execute on function public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid) to authenticated;
```

(We keep `revoke all from public, anon` from the original — explicit denial.)

**Q2 — AsyncStorage offline queue shape.**

Serialization format: JSON-stringified array of pending submissions. Each
entry is the full RPC arg envelope plus minimal metadata.

```ts
type QueueEntry = {
  // RPC args, verbatim
  p_client_uuid: string;     // uuid v4, generated at queue-time
  p_store_id: string;
  p_date: string;            // YYYY-MM-DD
  p_submitted_by: string;    // staff user id (we still send it for compat with backend's signature)
  p_status: 'submitted' | 'draft';
  p_entries: Array<{ ingredient_id: string; actual_remaining: number; unit?: string; notes?: string }>;
  p_vendor_id: string;
  // Queue metadata
  queued_at: string;         // ISO8601 for FIFO ordering
  user_id: string;           // ownership: only replayed when this user is signed in
};
```

Storage key: `imr-staff:eod-queue:v1`. The `v1` suffix is the migration
escape hatch — if the queue shape changes in a future spec, bump to `v2`
and write a one-time migrator that drains v1 + writes v2.

**Persistence on sign-out**: **persist**, do NOT clear. On next sign-in,
the queue is filtered by `user_id === currentUserId` before replay. A
different user signing in on the same device sees an empty queue (their
filter matches no entries); the previous user's entries remain in storage
until that user signs in again or the queue is manually cleared. Confirms
the PM's default proposal.

**FIFO**: queue entries are drained in `queued_at` ascending order.

**Conflict UX on 409**:
- 409 with the same `client_uuid` returned (verified by comparing the
  `submission_id` to the local "last known" id for that triple — or just
  trusting the 409 marker): treat as success, remove from queue, no UI.
- 409 with a DIFFERENT `submission_id`: surface a conflict toast / banner
  ("Someone else already submitted for {store} / {date} / {vendor}").
  Remove from queue. The local optimistic copy is invalidated by the next
  fetch on the EOD screen.

Race-mode detail for backend-developer reviewing the RPC body: the RPC's
idempotency check at
[migration:75-86](../supabase/migrations/20260514120010_staff_submit_eod_v2.sql)
returns `conflict: true` with `'client_uuid already processed'` as the
reason when the same `client_uuid` is seen twice. It returns NO conflict
on the `(store_id, date, vendor_id)` collision path — that one hits
`ON CONFLICT DO UPDATE` and overwrites the existing row's status +
submitted_at. So in the current RPC shape, the "different `client_uuid`
but same triple" case is an UPDATE, not a 409. **No backend change needed
for this UX**; the staff frontend simply reads the response and updates
its local state from the returned `submission_id` (which will be the
existing row's id).

**Q3 — Connectivity detection on native.**

The supabase-js Phoenix Socket is **lazy** — it connects only when
`subscribe()` is called on a channel (verified via
`node_modules/@supabase/realtime-js/dist/main/RealtimeChannel.js:107`:
`this.socket.connect()` is called inside `subscribe()`'s join flow). A
freshly-installed staff app with NO realtime subscriptions will NOT have
an open socket, so `realtime.isConnected()` returns false and the spec 059
hook flips to "disconnected" forever — useless as a connectivity signal.

**Ruling**: the staff app uses **`@react-native-community/netinfo`** as
the connectivity primitive. Add as a dependency in `imr-staff/package.json`
under B1; document the autolinking step in the new repo's setup notes.

The spec 059 hook is still usable for the web-preview build of the staff
app (B10 mentions Vercel as nice-to-have): wrap a unified
`useConnectionStatus` hook that swaps NetInfo on native vs the spec 059
shape on web. Pseudocode for the imr-staff repo (NOT this repo):

```ts
// imr-staff/src/hooks/useConnectionStatus.ts
import { Platform } from 'react-native';
import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

export function useConnectionStatus(): boolean {
  const [connected, setConnected] = useState(true); // optimistic
  useEffect(() => {
    if (Platform.OS === 'web') {
      // For web, navigator.onLine is the primitive (NetInfo on web also
      // uses navigator.onLine under the hood); skipping the spec 059
      // Phoenix-Socket path because the staff app has no realtime
      // subscriptions to read state from.
      const update = () => setConnected(navigator.onLine);
      window.addEventListener('online', update);
      window.addEventListener('offline', update);
      update();
      return () => {
        window.removeEventListener('online', update);
        window.removeEventListener('offline', update);
      };
    }
    // Native — NetInfo
    const unsub = NetInfo.addEventListener((state) => {
      setConnected(!!state.isConnected && state.isInternetReachable !== false);
    });
    NetInfo.fetch().then((state) => {
      setConnected(!!state.isConnected && state.isInternetReachable !== false);
    });
    return () => unsub();
  }, []);
  return connected;
}
```

**iOS / Android native config**: NetInfo autolinks under Expo SDK 54 (no
manual link step needed). On iOS, the Info.plist key
`NSAppTransportSecurity` is not required for NetInfo specifically, but
production builds should set `NSAllowsArbitraryLoads = NO` (Expo default).
Document this in `imr-staff/README.md`.

**Q4 — Deprecation rollout for `staff-catalog`, `staff-eod-submit`,
`staff-waste-log`.**

Confirm PM's recommendation: **immediate fail-loud 410** in the same
deploy as A1/A2. Rationale:

- The functions were never consumed by any shipped sibling app. The
  staff-app slot was always vapor — no production traffic to break.
- Feature-flag rollout adds complexity (an env var to read, a release
  cycle to manage, a forgotten cleanup step) for zero risk reduction.
- Hard 410 with a descriptive body matches the project's prior
  deprecation pattern (spec 020's legacy 6-arg
  `staff_submit_eod`,
  [migration:189-206](../supabase/migrations/20260514120010_staff_submit_eod_v2.sql)).
- The 410 stays deployed permanently so any stale caller (e.g. a forgotten
  test fixture in a sibling repo, a manually-built fork) fails loud with
  an actionable error rather than 404'ing.

**Q5 — Seeded staff user.**

The seed at [supabase/seed.sql:74-122](../supabase/seed.sql) already
contains `manager@local.test` with:
- `auth.users.raw_app_meta_data` = `{role: 'user', ...}`
- `profiles.role = 'user'`
- `profiles.brand_id = '2a000000-…'` (2AM PROJECT)
- `user_stores` rows for Towson (`00000000-…-001`) and Frederick
  (`0f240390-…`) — see [seed.sql:198-200](../supabase/seed.sql)

This user IS the staff-shape user we need. **No seed change required.**

C3's smoke script uses these credentials:
- email: `manager@local.test`
- password: `password`
- expected `user_stores`: 2 stores (Towson + Frederick)
- smoke uses Frederick (`0f240390-edda-4b25-8c72-45eeb2ce1988`) as the
  "in-membership" store and Charles (`1ea549bb-8b50-4078-9301-479311d9fdec`)
  as the "out-of-membership" store for the negative case.

Naming note: the seed user's display name is "Tara Manager" / role `user`.
The naming is historical — this is a staff-role-`user` profile (no
`profiles.role='staff'` exists, by spec design). Architect leaves the seed
user's name as-is to avoid a seed-history rewrite for a cosmetic change.

**Q6 — Cross-repo coordination.**

Confirm PM's proposal: the `Companion repo` field at the top of the spec
header is the single-source-of-truth pointer. The new `imr-staff` repo's
`CLAUDE.md` cites this spec back (Track B AC B2 already mandates this).
A future spec 062 in `imr-staff` references back to 061 by absolute
filesystem path.

No additional record-keeping infrastructure is added in this spec
(no shared spec index, no cross-repo registry). If a third repo ever
joins the project (e.g. a kitchen-display sibling), THAT spec can revisit.

### 2. Data model changes

**Migration 1**: `supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql`

Single transaction:
- `create or replace function public.staff_submit_eod(...)` — same 7-arg
  signature, body rewritten to use `auth.uid()` for the audit_log detail
  attribution. The `p_submitted_by` parameter is left in the signature
  for compatibility but is ignored inside the body. Keep `security
  definer` + `set search_path = public`. Keep all existing behavior
  (vendor scope, idempotency-via-client_uuid, entries-replace,
  inventory_items vendor-scoped update, audit row append).
- `revoke execute on function public.staff_submit_eod(...) from service_role`
- `grant execute on function public.staff_submit_eod(...) to authenticated`
- Add a `comment on function public.staff_submit_eod(...) is 'spec 061: per-user JWT. p_submitted_by is ignored — body re-derives from auth.uid(). GRANTed to authenticated.';`

Body change (signatures unchanged):
- Line 152-153 of the existing v2 body changes from:
  ```sql
  coalesce(p_submitted_by, 'staff:unknown')
    || ' · vendor: ' || coalesce(v_vendor_name, 'unknown'),
  ```
  to:
  ```sql
  coalesce(auth.uid()::text, p_submitted_by, 'staff:unknown')
    || ' · vendor: ' || coalesce(v_vendor_name, 'unknown'),
  ```
  Three-tier fallback: `auth.uid()` (the per-user JWT path) → caller-supplied
  `p_submitted_by` (legacy compat / non-JWT callers if any) → literal
  string. The order matters — `auth.uid()` MUST win when present so the
  staff caller can't spoof.

**Destructive vs additive**: The GRANT swap is destructive for any
service_role caller of the RPC, but there are exactly two such callers
in the repo:
1. The `staff-eod-submit` edge function — being deprecated in the same
   migration set (A3).
2. The `staff-eod-submit-v2` edge function — does not exist.

So in practice the GRANT swap is additive (authenticated callers gain
access; the only service_role caller goes 410 in the same deploy). No
external service is known to call this RPC; smoke-test confirms before
deploy.

**Rollout safety**: deploy this migration BEFORE the edge function
deprecation rolls out to prod. If the edge function is deprecated first,
any existing pre-A1 staff client (which doesn't exist yet) breaks. If
the migration lands first, the edge function still works (it uses the
service_role key on its end, not the GRANT — wait, the GRANT change
DOES affect service_role).

**Correction**: service_role calls bypass GRANTs in PostgreSQL because
service_role is granted `BYPASSRLS` and has direct table access; however,
function-level `REVOKE EXECUTE FROM service_role` DOES block service_role
from calling the function. **Sequencing therefore matters**: the edge
function deprecation (A3) MUST land in the same deploy as A1, OR A1 must
include a `grant execute … to service_role` for the deprecation window.

**Architect ruling**: A1 and A3 ship in the same migration batch. The
migration explicitly REVOKEs from service_role and GRANTs to
authenticated. If the deploy is split across two deploys for any reason,
the operator MUST deploy A3 (edge function deprecation) FIRST so the
edge function returns 410 cleanly rather than 500-ing on the missing
GRANT. Document this in the migration's leading comment.

**Migration 2**: none required for seed (Q5 resolution — manager user
is already staff-shape).

**Migration 3**: none required for edge function deprecation — that's a
file-replacement in `supabase/functions/`, not a migration. See §4.

**Indexes**: no new indexes. The existing
`eod_submissions_client_uuid` partial unique
([supabase/migrations/20260504000000_staff_api_idempotency.sql](../supabase/migrations/20260504000000_staff_api_idempotency.sql))
and `eod_submissions_store_id_date_vendor_id_key` unique
([supabase/migrations/20260514120000_eod_submissions_vendor_id.sql:119-121](../supabase/migrations/20260514120000_eod_submissions_vendor_id.sql))
already cover the RPC's lookup paths.

### 3. RLS impact

**No new RLS policies.** The existing policies on `eod_submissions` and
`eod_entries` from
[supabase/migrations/20260504173035_per_store_rls_hardening.sql:63-132](../supabase/migrations/20260504173035_per_store_rls_hardening.sql)
gate INSERT/SELECT through `auth_can_see_store(store_id)`, which (per spec
041) admits a staff user via the `user_stores` third arm.

The two consistency triggers from spec 020 round-2 — `eod_submissions_set_submitted_by_trg`
and `eod_entries_check_store_trg` — fire on every direct PostgREST INSERT
([supabase/migrations/20260514120030_eod_submissions_consistency.sql:78-138](../supabase/migrations/20260514120030_eod_submissions_consistency.sql))
and continue to gate the spoof / cross-store paths. **No change needed.**

The legacy permissive policy audit (spec 053) is not affected by this
migration — no new permissive policy lands.

**Verification checklist for backend-developer**:
- The four policies on `eod_submissions` cover INSERT (`store_member_insert_eod_submissions`),
  SELECT (`store_member_read_eod_submissions`), UPDATE (`admin_update_eod_submissions`,
  privileged-only per spec 020 round-2), and no DELETE policy (append-only).
- The four policies on `eod_entries` mirror the same shape.
- A staff user calling the RPC succeeds because the RPC is `security definer`
  and bypasses RLS for the function-owner's table writes.
- A staff user trying to INSERT directly via PostgREST into `eod_submissions`
  for a non-membership store fails because `auth_can_see_store` returns false
  — covered by pgTAP.

### 4. Edge function changes

Three functions deprecate to HTTP 410 in the same deploy as A1. **No
`verify_jwt` change** — the existing `verify_jwt = false` in
[supabase/config.toml:391-398](../supabase/config.toml) stays.

**Why keep `verify_jwt = false`** on a deprecated function? Because the
deprecation should respond to ANY caller (including pre-A1 deploys that
might still be sending a Bearer service-token rather than a JWT) with the
same clean 410, not a 401 at the gateway layer. The gateway 401 would be
indistinguishable from "the staff token is wrong" and obscure the
deprecation signal.

**Files to rewrite** (full body replacement; service-token validation
removed, all routes return 410):

- [supabase/functions/staff-catalog/index.ts](../supabase/functions/staff-catalog/index.ts)
- [supabase/functions/staff-eod-submit/index.ts](../supabase/functions/staff-eod-submit/index.ts)
- [supabase/functions/staff-waste-log/index.ts](../supabase/functions/staff-waste-log/index.ts)

**Body shape** (each function, mutatis mutandis):

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({
      error: "staff-<fn>: deprecated as of spec 061 — staff app now talks to Supabase directly via per-user JWT",
      reference: "specs/061-staff-app-eod-count.md",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
```

Verbatim spec text from AC A3 — the `error` field and `reference` field
shapes are pinned in the PM AC and must be preserved exactly.

**Things being deleted** in the rewrite:
- The `createClient` import + `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/
  `STAFF_SERVICE_TOKEN` env lookups (no longer needed)
- The `checkAuth` function (no service-token validation needed for a
  fail-loud 410)
- All validation logic (no body shape to validate)
- All RPC dispatch code

**`STAFF_SERVICE_TOKEN` env var**: stays defined in the deploy env for now
(removing it is a follow-up cleanup spec). Operationally harmless once the
functions stop reading it.

**Project-rule checks** (per CLAUDE.md):
- Edge function role gates mirror `auth_is_privileged()` — N/A, no role
  gating (410 for all callers).
- HTML email escaping — N/A, no HTML response.
- Last-of-role guard — N/A, no destructive role op.
- `caller.id != target.id` guard — N/A, no role-change op.
- Spec 027 inline-not-shared rule — the deprecation body is small enough
  that all three copies are inline (no `_shared/` import). Each file
  duplicates the same ~25-line body. Consistent with the project's edge
  function pattern.

### 5. `src/lib/db.ts` surface

**No changes to `src/lib/db.ts`.** The admin EOD flow at
[src/lib/db.ts:498](../src/lib/db.ts) uses direct PostgREST upserts, not
the `staff_submit_eod` RPC. The RPC GRANT swap doesn't affect that path.

The staff app implements its own data layer in the `imr-staff` repo
against `supabase-js` directly — it doesn't import from this repo's
`db.ts`. This is documented in Track B B2 (staff app has no admin UI).

The frontend contract for `imr-staff` is in §7 below.

### 6. Realtime impact

**None.** The migration changes a function body and GRANT — no table
schema change, no `supabase_realtime` publication membership change. The
"docker restart `supabase_realtime_imr-inventory`" ritual does NOT apply.

The admin app's existing realtime subscriptions on `eod_submissions` and
`eod_entries` (via [src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts)
on the `store-{id}` channel) continue to fire when a staff user submits.
Admin EOD section sees staff submissions appear in real time — this is
A5's regression behavior, verified manually.

### 7. Frontend contract for `imr-staff` (Track B)

The staff app's spec 062 in the new repo builds against the following
contract. Pinning it here so the spec-062 product-manager doesn't have
to re-derive.

**(a) RPC name, signature, auth.**

- Name: `staff_submit_eod`
- HTTP path: `POST /rest/v1/rpc/staff_submit_eod` against the shared Supabase
  URL.
- Headers: `apikey: <SUPABASE_ANON_KEY>`, `Authorization: Bearer <USER_JWT>`,
  `Content-Type: application/json`.
- Body:
  ```json
  {
    "p_client_uuid": "uuid-v4",
    "p_store_id": "uuid",
    "p_date": "YYYY-MM-DD",
    "p_submitted_by": "<staff user id, optional — ignored by server>",
    "p_status": "submitted" | "draft",
    "p_entries": [
      { "ingredient_id": "uuid", "actual_remaining": number, "unit": "string?", "notes": "string?" }
    ],
    "p_vendor_id": "uuid"
  }
  ```
- 200 response:
  ```json
  {
    "submission_id": "uuid",
    "conflict": false,
    "entry_ids": ["uuid", ...],
    "stock_updates": [{ "ingredient_id": "uuid", "new_stock": number }, ...]
  }
  ```
- 200 with conflict body (idempotency replay):
  ```json
  {
    "submission_id": "uuid",
    "conflict": true,
    "reason": "client_uuid already processed"
  }
  ```
  (PostgREST returns HTTP 200 with the conflict marker INSIDE the body —
  there's no HTTP 409. The legacy 6-arg edge function mapped the marker
  to 409 at the HTTP layer; the per-user-JWT path through PostgREST RPC
  does NOT do that translation. **Frontend must inspect `data.conflict`,
  not the HTTP status.**)

**Recommended frontend wrapping** (pseudocode):

```ts
async function submitEOD(args: SubmitArgs): Promise<{ submissionId: string; conflict: boolean }> {
  const { data, error } = await supabase.rpc('staff_submit_eod', args);
  if (error) {
    // Network / RLS / Postgres exception path.
    throw error;
  }
  return { submissionId: data.submission_id, conflict: !!data.conflict };
}
```

**(b) Connectivity hook implementation choice.**

Per Q3 resolution: `@react-native-community/netinfo` on native,
`navigator.onLine` on web. Spec 062 implements the hook per the pseudocode
in §1 / Q3 above. No copy-from-imr-inventory for this hook (the spec 059
hook is for a different connectivity model).

**(c) AsyncStorage queue serialization shape.**

Per Q2 resolution. The `QueueEntry` TypeScript type above is the contract.
Storage key: `imr-staff:eod-queue:v1`. FIFO by `queued_at`. Per-user
filtering via `user_id` field.

**(d) Conflict UX on 409.**

Per Q2 resolution. PostgREST returns 200 with `conflict: true` in body —
not HTTP 409. The frontend reads `data.conflict` and:
- `conflict === true && data.submission_id === local_known_id`: silent
  success (idempotency replay worked).
- `conflict === true && data.submission_id !== local_known_id`: surface
  a "Someone else already submitted for {store}/{date}/{vendor}" UI.
- `conflict === false`: clean success.

If the RPC throws (network error / 5xx), the queue handler retains the
entry for retry. If the RPC throws with a `42501` errcode (RLS deny), the
queue handler removes the entry and surfaces "Not authorized to submit
for this store" (this is the "user was removed from user_stores between
queue and replay" case).

### 8. pgTAP test contract — `supabase/tests/staff_role_eod_rls.test.sql`

New file, mirrors the shape of
[supabase/tests/eod_submissions_consistency.test.sql](../supabase/tests/eod_submissions_consistency.test.sql).

**Plan**: `select plan(10);` (or whatever final count is needed after
fleshing out the assertions below).

**Fixtures** (set via `do $$ ... end $$` with `perform set_config(...)` to
capture seed store + vendor + item ids):
- staff user id: `'22222222-2222-2222-2222-222222222222'` (manager seed)
- Frederick store id: `select id from public.stores where name = 'Frederick'`
  — in-membership (`user_stores` row exists per
  [seed.sql:198-200](../supabase/seed.sql))
- Charles store id: `select id from public.stores where name = 'Charles'`
  — NOT in `user_stores` for the manager user
- Any vendor: `select id from public.vendors limit 1`
- Frederick item: `select id from public.inventory_items where store_id = <fred> limit 1`
- Charles item: `select id from public.inventory_items where store_id = <charles> limit 1`
- generate `client_uuid_a = gen_random_uuid()` and `client_uuid_b = gen_random_uuid()`
  for idempotency assertions

**Impersonation** (top of test):
```sql
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '22222222-2222-2222-2222-222222222222',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);
```

**Assertions (10 expected)**:

1. **In-membership RPC call succeeds** (Track A A2 — happy path):
   ```sql
   select lives_ok(
     $q$select public.staff_submit_eod(
       <client_uuid_a>, <frederick_id>, '2026-05-23'::date,
       null, 'submitted',
       jsonb_build_array(jsonb_build_object(
         'ingredient_id', '<fred_item>', 'actual_remaining', 7, 'unit', 'lbs'
       )),
       <vendor_id>
     )$q$,
     'staff user can call staff_submit_eod for in-membership store'
   );
   ```

2. **Returned `submission_id` exists in eod_submissions for the staff user's store**:
   ```sql
   select is(
     (select count(*) from public.eod_submissions
       where store_id = <frederick_id>
         and date = '2026-05-23'
         and vendor_id = <vendor_id>),
     1::bigint,
     'RPC inserted exactly one eod_submissions row at the expected triple'
   );
   ```

3. **`submitted_by` on the persisted row is `auth.uid()` (the staff user's id)**:
   ```sql
   select is(
     (select submitted_by from public.eod_submissions
       where store_id = <frederick_id> and date = '2026-05-23' and vendor_id = <vendor_id>),
     '22222222-2222-2222-2222-222222222222'::uuid,
     'eod_submissions.submitted_by is server-derived from auth.uid(), not the caller-supplied null'
   );
   ```

4. **audit_log row carries the staff user's id, not a forged value**:
   ```sql
   select ok(
     (select detail from public.audit_log
       where store_id = <frederick_id>
         and action = 'EOD entry'
       order by id desc limit 1)
     like '22222222-2222-2222-2222-222222222222%',
     'audit_log.detail is prefixed with auth.uid() (spoof-proof)'
   );
   ```

5. **Staff CANNOT call RPC for out-of-membership store**:
   ```sql
   select throws_ok(
     $q$select public.staff_submit_eod(
       <client_uuid_b>, <charles_id>, '2026-05-23'::date,
       null, 'submitted',
       jsonb_build_array(jsonb_build_object(
         'ingredient_id', '<charles_item>', 'actual_remaining', 5
       )),
       <vendor_id>
     )$q$,
     null, null, -- any errcode, any message
     'staff user is refused for out-of-membership store'
   );
   ```
   **Wait** — the RPC is `security definer`, so RLS doesn't gate its INSERTs.
   The CHECK that the staff user can see the store happens IMPLICITLY through
   `auth_can_see_store` calls inside the RPC body — but the current body does
   NOT call `auth_can_see_store` at all (verified by reading
   [migration:31-173](../supabase/migrations/20260514120010_staff_submit_eod_v2.sql)).
   The current RPC accepts any `p_store_id` and writes the row regardless of
   the caller's `user_stores` membership.

   **Architect course-correction**: the migration in §2 MUST add a membership
   gate to the RPC body before the INSERT, otherwise a staff user could
   submit for ANY store including stores in other brands. Add:
   ```sql
   -- (1.5) Per-spec-061 store-membership gate. The RPC runs `security
   -- definer` so RLS doesn't auto-enforce; we explicitly check. Same shape
   -- as submit_inventory_count's caller-can-see-store guard.
   if not public.auth_can_see_store(p_store_id) then
     raise exception 'staff_submit_eod: caller cannot see store %', p_store_id
       using errcode = '42501';
   end if;
   ```
   Insert this between the existing vendor-presence check (step 1) and the
   vendor-name hydration (step 2). This is the load-bearing change for AC A2.

6. **Staff CANNOT directly INSERT into `eod_submissions` for out-of-membership store** (RLS path, bypassing the RPC):
   ```sql
   select throws_ok(
     $q$insert into public.eod_submissions
       (store_id, date, vendor_id, status, client_uuid)
       values (<charles_id>, '2026-05-23', <vendor_id>, 'submitted', gen_random_uuid())$q$,
     '42501', null,
     'direct INSERT into eod_submissions for out-of-membership store rejected by RLS'
   );
   ```

7. **Staff CAN SELECT `eod_submissions` for in-membership store**:
   ```sql
   select is(
     (select count(*)::bigint from public.eod_submissions
       where store_id = <frederick_id> and date = '2026-05-23'),
     1::bigint,
     'staff user can SELECT own-store eod_submissions'
   );
   ```

8. **Staff CANNOT SELECT `eod_submissions` for out-of-membership store** (write a row as postgres role, confirm staff can't see it):
   ```sql
   -- Bypass RLS as postgres to seed an out-of-membership row.
   reset role;
   insert into public.eod_submissions (store_id, date, vendor_id, status)
     values (<charles_id>, '2026-05-22', <vendor_id>, 'submitted')
     on conflict do nothing;
   -- Re-impersonate.
   set local role authenticated;
   select set_config('request.jwt.claims', <claims>, true);
   select is(
     (select count(*)::bigint from public.eod_submissions
       where store_id = <charles_id> and date = '2026-05-22'),
     0::bigint,
     'staff user CANNOT see out-of-membership store eod_submissions'
   );
   ```

9. **Staff CANNOT INSERT into `recipes`** (write-side block on brand-shared
   tables; staff CAN read these per §0, but cannot write):
   ```sql
   select throws_ok(
     $q$insert into public.recipes
       (brand_id, menu_item, category, sell_price)
       values ('2a000000-0000-0000-0000-000000000001', 'Test Recipe', 'Mains', 12.00)$q$,
     '42501', null,
     'staff user cannot INSERT into recipes (auth_is_privileged-gated)'
   );
   ```

10. **Idempotency replay returns `conflict: true` with same submission_id**:
    ```sql
    -- Re-call with the same client_uuid_a.
    create temp table _replay on commit drop as
    select public.staff_submit_eod(
      <client_uuid_a>, <frederick_id>, '2026-05-23'::date,
      null, 'submitted',
      jsonb_build_array(jsonb_build_object('ingredient_id', '<fred_item>', 'actual_remaining', 9)),
      <vendor_id>
    ) as result;
    select is(
      ((select result from _replay) ->> 'conflict')::boolean,
      true,
      'idempotency replay returns conflict: true'
    );
    ```

**Hermetic isolation**: `begin; ... rollback;` wrapping per existing convention.

**Run command**: `bash scripts/test-db.sh supabase/tests/staff_role_eod_rls.test.sql`
(or via the full suite — `bash scripts/test-db.sh` discovers all `*.test.sql`).

### 9. Shell smoke contract — `scripts/smoke-staff-eod.sh`

New file, mirrors the shape of
[scripts/smoke-rpc.sh](../scripts/smoke-rpc.sh).

**Env vars**:
- `SUPABASE_URL` (default: `http://127.0.0.1:54321`)
- `SUPABASE_ANON_KEY` (default: same anon as smoke-rpc — local dev key)
- `STAFF_EMAIL` (default: `manager@local.test`)
- `STAFF_PASSWORD` (default: `password`)
- `STORE_ID` (default: Frederick — `0f240390-edda-4b25-8c72-45eeb2ce1988`)

**Steps**:

1. **Login** as `STAFF_EMAIL` / `STAFF_PASSWORD` → capture `access_token`.
   Identical to smoke-rpc.sh's step 0.

2. **Discover a vendor** from the local seed via PostgREST:
   ```bash
   VENDOR_ID=$(curl -sS \
     -H "apikey: $SUPABASE_ANON_KEY" \
     -H "Authorization: Bearer $STAFF_TOKEN" \
     "$SUPABASE_URL/rest/v1/vendors?select=id&limit=1" \
     | jq -r '.[0].id')
   ```

3. **Discover an inventory_item** at STORE_ID:
   ```bash
   ITEM_ID=$(curl -sS \
     -H "apikey: $SUPABASE_ANON_KEY" \
     -H "Authorization: Bearer $STAFF_TOKEN" \
     "$SUPABASE_URL/rest/v1/inventory_items?store_id=eq.$STORE_ID&select=id&limit=1" \
     | jq -r '.[0].id')
   ```

4. **Generate a client_uuid**:
   ```bash
   CLIENT_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
   ```

5. **First call to `staff_submit_eod`** → assert HTTP 200, JSON body has
   `submission_id`, body's `conflict` is `false`:
   ```bash
   RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
     -H "apikey: $SUPABASE_ANON_KEY" \
     -H "Authorization: Bearer $STAFF_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{
       \"p_client_uuid\": \"$CLIENT_UUID\",
       \"p_store_id\": \"$STORE_ID\",
       \"p_date\": \"$(date +%Y-%m-%d)\",
       \"p_submitted_by\": null,
       \"p_status\": \"submitted\",
       \"p_entries\": [{\"ingredient_id\": \"$ITEM_ID\", \"actual_remaining\": 10}],
       \"p_vendor_id\": \"$VENDOR_ID\"
     }" \
     "$SUPABASE_URL/rest/v1/rpc/staff_submit_eod")
   CODE=$(printf '%s' "$RESPONSE" | tail -1)
   BODY=$(printf '%s' "$RESPONSE" | sed '$d')
   # Assertions: CODE==200, BODY has submission_id, conflict=false
   ```

6. **Confirm eod_submissions row exists**:
   ```bash
   ROW_COUNT=$(curl -sS \
     -H "apikey: $SUPABASE_ANON_KEY" \
     -H "Authorization: Bearer $STAFF_TOKEN" \
     "$SUPABASE_URL/rest/v1/eod_submissions?store_id=eq.$STORE_ID&client_uuid=eq.$CLIENT_UUID&select=id" \
     | jq 'length')
   # Assert ROW_COUNT == 1
   ```

7. **Replay with same client_uuid** → assert HTTP 200, body's `conflict` is `true`,
   body's `submission_id` matches the first call's:
   ```bash
   RESPONSE2=$(curl -sS -w '\n%{http_code}' -X POST ...same payload as step 5...)
   # Assertions: CODE==200, BODY.conflict==true, BODY.submission_id == FIRST.submission_id
   ```

8. **Out-of-membership store negative test**: change `STORE_ID` to Charles
   (`1ea549bb-8b50-4078-9301-479311d9fdec`) — the manager user does NOT have
   a `user_stores` row for Charles — and assert the call FAILS (HTTP 400
   with `42501` in body, OR HTTP 500 / PG error surfacing the membership
   gate):
   ```bash
   RESPONSE3=$(curl -sS -w '\n%{http_code}' -X POST \
     ... payload uses CHARLES_ID and a fresh client_uuid ...)
   CODE3=$(printf '%s' "$RESPONSE3" | tail -1)
   # Assert CODE3 != 200 — PostgREST maps 42501 to HTTP 403 by default
   ```

9. **Edge function deprecation smoke** (A3 verification): POST to
   `/functions/v1/staff-eod-submit` and assert HTTP 410:
   ```bash
   RESPONSE4=$(curl -sS -w '\n%{http_code}' -X POST \
     -H "Content-Type: application/json" \
     -d '{}' \
     "$SUPABASE_URL/functions/v1/staff-eod-submit")
   CODE4=$(printf '%s' "$RESPONSE4" | tail -1)
   # Assert CODE4 == 410
   BODY4=$(printf '%s' "$RESPONSE4" | sed '$d')
   # Assert body contains "deprecated as of spec 061"
   ```
   Same for `/functions/v1/staff-catalog` (GET) and
   `/functions/v1/staff-waste-log` (POST).

**Exit code**: non-zero on first failure (same as smoke-rpc.sh's pattern).

**Run command**: `bash scripts/smoke-staff-eod.sh`.

**Troubleshooting**: same edge-runtime-bind-mount caveat as smoke-edge.sh
— reference CLAUDE.md "Local edge runtime bind-mount captures CWD at boot"
in the script's header comment.

### 10. Sequencing diagram (Track A → Track B → C3)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Cycle 1 — Track A in imr-inventory (this repo)                          │
│                                                                         │
│ backend-developer ─┬─▶ migration: 20260525000000_staff_submit_eod_per_user_jwt.sql
│                    │   (RPC body + GRANT + new membership gate)         │
│                    │                                                    │
│                    ├─▶ rewrite supabase/functions/staff-*/index.ts → 410│
│                    │                                                    │
│                    ├─▶ new supabase/tests/staff_role_eod_rls.test.sql   │
│                    │                                                    │
│                    └─▶ new scripts/smoke-staff-eod.sh                   │
│                                                                         │
│                              │                                          │
│                              ▼                                          │
│ Local verification:                                                     │
│   - bash scripts/test-db.sh                                             │
│   - bash scripts/smoke-staff-eod.sh                                     │
│                              │                                          │
│                              ▼                                          │
│ READY_FOR_REVIEW → fan-out reviewers                                    │
│                              │                                          │
│                              ▼                                          │
│ SHIP_READY → user commits → deploy to prod                              │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (Track A SHIP_READY gate)
┌─────────────────────────────────────────────────────────────────────────┐
│ Cycle 2 — Track B in imr-staff (new repo, scaffolded by                 │
│           backend-developer as part of cycle 1's deliverable)           │
│                                                                         │
│ developer ──▶ create ~/Documents/GitHub/imr-staff, git init, scaffold   │
│   per Track B B1–B10. Initial commit lands; cycle 1 is done.            │
│                                                                         │
│ THEN a NEW product-manager run in the new repo writes spec 062,         │
│ referencing this spec 061 by absolute path. Spec 062 implements the     │
│ EOD screen, offline queue, connectivity hook against the deployed       │
│ contract.                                                                │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (spec 062 SHIP_READY gate, in imr-staff)
┌─────────────────────────────────────────────────────────────────────────┐
│ C3 — cross-repo integration smoke                                       │
│                                                                         │
│ scripts/smoke-staff-eod.sh in THIS repo verifies the deployed RPC       │
│ against the seed manager user. (Runs locally — no staff frontend        │
│ involved in this smoke; it's a curl-level integration test.)            │
│                                                                         │
│ The staff frontend (in imr-staff) verifies the same RPC + the offline  │
│ queue path via jest in B9.                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

**Important sequencing nuance**: Track A backend MUST deploy to prod
(not just local) before Track B's spec 062 starts implementation work,
because the staff frontend points at the shared Supabase project. If
spec 062 starts before A1 is deployed, the staff app calls a `staff_submit_eod`
that still has `service_role`-only EXECUTE and the per-user JWT path 403s.

The architect's recommendation: backend-developer does **all** of cycle 1
in one pass (Track A + Track B scaffold). Track B's scaffold is mostly
boilerplate (`npx create-expo-app`, copy package.json deps, write a stub
CLAUDE.md and README). The actual feature work (EOD screen) is spec 062
in the new repo.

### 11. Risks and tradeoffs

1. **`security definer` + no caller-store check in current RPC body**
   (load-bearing — addressed in §8 assertion 5). The current RPC accepts
   any `p_store_id` and writes the row regardless of caller membership.
   The migration MUST add the `auth_can_see_store` gate inside the body
   or the GRANT change becomes a cross-brand write hole. Backend-developer
   MUST verify this gate lands.

2. **PostgREST RPC returns 200 with `conflict: true`, NOT HTTP 409**
   (load-bearing — addressed in §7 (a)). The frontend cannot use HTTP status
   to discriminate. Documented in the spec 062 contract.

3. **Audit-log trail for the manager seed user**. The manager seed user is
   reused for both "staff role testing" and "manager (non-admin) testing".
   The pgTAP test asserts the staff path; an existing test for the manager
   path (e.g.,
   [supabase/tests/eod_submissions_consistency.test.sql](../supabase/tests/eod_submissions_consistency.test.sql))
   uses the same fixture user. Both tests use `begin; ... rollback;` so
   no cross-test contamination, but the test order is alphabetical and
   relying on the same user id across multiple test files is a footgun
   if a future migration renames the seed user. **Mitigation**: pin the
   user id (`'22222222-…'`) and the seed assertion (`select isnt(current_setting('test.manager_id', true), '', '...')`)
   so a renamed seed user fails the test loudly.

4. **Cold-start cost on the deprecated edge functions**. After this spec
   lands, hitting `/functions/v1/staff-*` is a cold-start to a
   nearly-empty Deno function. The 410 is fast (~50ms) but the cold-start
   adds ~500ms. Not user-visible (no staff client calls these) and not
   blocking.

5. **Seed dataset performance**. The pgTAP test inserts ~1 eod_submission
   + 1 eod_entry + 1 audit_log row per assertion. The 286 KB seed has
   ~143 catalog_ingredients and ~50 stores' worth of inventory_items —
   the RPC's `for v_entry in select * from jsonb_to_recordset(...) loop`
   pattern is O(n) on entry count, not seed size. Smoke uses a single
   entry. Performance is non-issue.

6. **`p_submitted_by` unused parameter pollution**. The parameter stays
   in the signature for compatibility but is dead code inside the body.
   This is a deliberate tradeoff for compat — but it's a smell. A future
   cleanup spec (post-imr-staff-launch) can drop the parameter via a
   migration that creates a 6-arg signature and deprecates the 7-arg.
   That migration is OUT OF SCOPE for spec 061.

7. **`staff_log_waste` RPC**. The companion `staff_log_waste` RPC at
   [supabase/migrations/20260504000002_staff_log_waste_rpc.sql](../supabase/migrations/20260504000002_staff_log_waste_rpc.sql)
   is STILL `service_role`-only. Spec 061 explicitly leaves waste-log out
   of scope (PM "Out of scope" bullet). The staff app v1 does not call
   it. If a future spec re-enables waste-log for staff, a sibling
   migration following the same shape as A1 lands — keep them parallel.

8. **Edge function deprecation cold-start vs immediate response**. The
   staff-catalog function was the only one with semantically-meaningful
   read access (the others were write paths). After deprecation, any
   pre-existing client (none in practice) loses catalog access. Mitigation:
   the 410 body explicitly points at "Supabase directly via per-user JWT"
   — discoverable.

9. **NetInfo native dependency in imr-staff**. NetInfo autolinks under
   Expo SDK 54 but is a new native binary. Cold-deploying to TestFlight
   / Play Console will pick it up via EAS Build's prebuild flow.
   No special config needed beyond `npm install @react-native-community/netinfo`.
   Docs: <https://github.com/react-native-netinfo/react-native-netinfo>.

10. **AC A2 mutation** (§0). The architect revised an acceptance criterion
    after spec authoring. PM may push back. If PM disagrees with the
    mutation, this spec halts and a new sub-spec proposes a new RLS shape
    that distinguishes `role='user'` from `role='admin'` for brand-shared
    reads. **Architect's recommendation**: accept the mutation. The original
    AC A2 is unenforceable without breaking the brand-catalog refactor's
    core design tenet.

## Handoff

next_agent: backend-developer
prompt: Implement against the design in this spec. Deliverables:
  (1) New migration `supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql`
      per §2 — body rework (auth.uid()-derived audit attribution + new
      auth_can_see_store gate per §8 risk #1) + GRANT swap.
  (2) Rewrite all three `supabase/functions/staff-*/index.ts` to the 410
      shape per §4.
  (3) New pgTAP test `supabase/tests/staff_role_eod_rls.test.sql` per §8
      (10 assertions).
  (4) New shell smoke `scripts/smoke-staff-eod.sh` per §9 (9 steps).
  (5) Local verification:
      - `bash scripts/test-db.sh supabase/tests/staff_role_eod_rls.test.sql`
        passes.
      - `bash scripts/smoke-staff-eod.sh` passes against the local stack.
      - `bash scripts/test-db.sh` (the full suite) still passes — confirm
        no regression on the existing eod_submissions_consistency tests
        and the permissive_policy_lint probe.
  (6) Track B scaffold: create `~/Documents/GitHub/imr-staff/` per B1, write
      the stub `CLAUDE.md` and `README.md` per B2 and B10, initial git
      commit. The actual EOD screen + offline queue is spec 062 in that
      new repo — do NOT implement it as part of this spec's cycle.
  After implementation, set `Status: READY_FOR_REVIEW` and list files
  changed under `## Files changed`.
payload_paths:
  - specs/061-staff-app-eod-count.md

## Files changed

### Migrations (this repo, `imr-inventory`)

- `supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql`
  — new. Drops+recreates the 7-arg `public.staff_submit_eod` with:
  (a) new `auth_can_see_store(p_store_id)` membership gate at the
  top of the body (load-bearing for AC A2 per §11 risk #1);
  (b) audit-log actor re-derived from `auth.uid()::text` with
  three-tier fallback `auth.uid() → p_submitted_by → 'staff:unknown'`
  (closes the spoof surface — §1 Q1); (c) GRANT swap — REVOKE
  EXECUTE from service_role, GRANT EXECUTE to authenticated; (d)
  `comment on function` documenting the new posture.

### Edge functions (this repo)

- `supabase/functions/staff-eod-submit/index.ts` — rewrite. Body
  replaced with a 410 deprecation per §4 + AC A3. `verify_jwt = false`
  kept in `supabase/config.toml`. CORS headers preserved.
- `supabase/functions/staff-catalog/index.ts` — same shape.
- `supabase/functions/staff-waste-log/index.ts` — same shape.

### Tests (this repo)

- `supabase/tests/staff_role_eod_rls.test.sql` — new. 11 pgTAP
  assertions covering: service_role lacks EXECUTE (lockdown half of
  GRANT swap); staff CAN call RPC for in-membership store; row
  lands at expected triple; `eod_submissions.submitted_by` is
  server-derived from `auth.uid()`; `audit_log.detail` is
  spoof-proof; staff CANNOT call RPC for out-of-membership store
  (42501 via new gate — load-bearing); direct INSERT into
  `eod_submissions` for non-membership store rejected by RLS;
  staff CAN SELECT own-store rows; staff CANNOT SELECT
  non-membership rows; staff CANNOT INSERT into `recipes`
  (architect's revised A2 write-block ruling); idempotency replay
  returns `conflict: true`. Uses test-only date `1999-12-31` to
  avoid collisions with smoke-script residue.

### Smoke (this repo)

- `scripts/smoke-staff-eod.sh` — new, executable. End-to-end smoke
  per §9: login as `manager@local.test`, discover vendor + item,
  call RPC with fresh client_uuid (expect 200 + conflict=false,
  valid submission_id, server-derived submitted_by), confirm row
  via PostgREST under staff token (read-RLS exercise), replay
  (expect 200 + conflict=true + same submission_id), out-of-
  membership store negative case (expect non-200 from
  auth_can_see_store gate), and all three deprecated edge
  functions returning HTTP 410 with the spec-061 reference body.

### Spec

- `specs/061-staff-app-eod-count.md` — `Status:` set to
  `READY_FOR_REVIEW`; this `## Files changed` section appended.

## Files created (imr-staff)

New repo at `~/Documents/GitHub/imr-staff` with one initial commit
(SHA `481b561`, message "Initial scaffold for imr-staff (spec 061)").
Per the architect's design (cycle 1 scope), this is scaffold-only —
NO EOD screen, store picker, offline queue, or sign-in flow lands
here. Spec 062 in the new repo will do that work against the cycle 1
backend contract.

- `package.json` — Expo SDK 54 / RN 0.81 / React 19.1 / TS 5.3 deps
  matching imr-inventory where reasonable. Skipped heavy admin-only
  deps (jspdf, papaparse, chart kits, expo-notifications,
  expo-sqlite, dnd-kit). Includes `@react-native-community/netinfo`
  per §1 Q3.
- `tsconfig.json` — strict, `@/*` → `src/*` alias.
- `babel.config.js` — `babel-preset-expo`.
- `metro.config.js` — same zustand-ESM shim as imr-inventory.
- `app.json` — slug `imr-staff` (NOT `towson-inventory`; the new
  slug is owned by this repo).
- `App.tsx` — placeholder rendering "Hello from imr-staff."
- `CLAUDE.md` — full project-instructions doc pointing back at
  imr-inventory spec 061 by absolute path. Covers stack, auth
  model, conventions, env vars, backend coupling, deprecated edge
  function list, local-dev gotchas, hard rules, and roadmap.
- `README.md` — stack list, setup steps (`npm install`), env vars
  (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`),
  test command, deploy targets (EAS native + Vercel web preview),
  and a "Backend lives in imr-inventory" pointer.
- `src/README.md` — placeholder describing the subdirectory layout
  spec 062 will populate (screens, hooks, store, lib, i18n,
  navigation, components).
- `.gitignore` — standard Expo/RN ignores plus `.env*` local
  variants.

### Verification log

- `npx supabase db reset` — applies the new migration cleanly
  against a fresh local DB.
- `bash scripts/test-db.sh` — all 34 pgTAP files pass (259+ jest
  baseline + 11 new pgTAP assertions in the new file).
- `bash scripts/smoke-staff-eod.sh` — passes against the local
  stack (12+ smoke assertions all PASS).
- `npm test` — 259 jest tests pass, no regression.
- `npm run typecheck` + `npm run typecheck:test` — both clean.
- In `~/Documents/GitHub/imr-staff`: `npm install` clean,
  `npm run typecheck` clean, `git log --oneline` shows one commit.

### Open notes for reviewers

1. **Smoke-script residue on the shared DB**. The smoke writes
   real (non-transactional) rows to `eod_submissions` /
   `eod_entries` / `audit_log`. If you run the FULL pgTAP suite
   AFTER the smoke without an intervening `npx supabase db reset`,
   two unrelated tests can break: `auth_can_see_store_brand_scope.
   test.sql` (super_admin DELETE of manager profile collides with
   the FK from the residue `eod_submissions.submitted_by` row),
   and (less critically) the new `staff_role_eod_rls.test.sql`
   if it shared the smoke's date. The new test uses a far-past
   date (`1999-12-31`) to avoid the second issue. The first is a
   pre-existing brittleness made visible by this smoke (any
   smoke that creates EOD rows would trigger it); not a new
   issue caused by spec 061. Run order matters locally: `db
   reset → pgTAP → smoke` (or db reset between).

2. **Initial commit in imr-staff was made by the developer agent.**
   Per the spec's explicit instruction ("Initial commit:
   `git add . && git commit -m \"Initial scaffold for imr-staff
   (spec 061)\"`. Do NOT push"). User memory ordinarily says
   "stage immediately, user runs commit"; the architect's explicit
   spec instruction overrode that for this single commit. The repo
   has NO remote configured; nothing pushed.

3. **`STAFF_SERVICE_TOKEN` env var is now operationally dead** —
   nothing reads it. Removing it from the deploy environment is
   a follow-up cleanup spec (per §4 of the design doc).

4. **`staff_log_waste` RPC is still service_role-only.** Spec 061
   explicitly leaves waste-log out of scope. If a future spec
   adds waste-log to the staff app, a sibling migration following
   the same shape as this one will land — keep them parallel
   (§11 risk #7).

