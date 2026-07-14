# Backend-architect drift review — Spec 118 (PWA per-device notification toggle)

Reviewer: backend-architect (post-implementation mode)
Verdict: **No drift.** Implementation matches the `## Backend design` contract. 0 Critical, 0 Should-fix, 3 Minor (all informational / pre-existing / by-design).

---

## 1. Cron edits (§4) — MATCHES

Both crons are genuinely code-only, with NO migration and NO realtime change, exactly as designed.

- **`notifications_enabled` fully removed from the cron layer.** `grep notifications_enabled supabase/functions/` returns **zero** hits. `grep optedOut` returns zero hits under `supabase/functions/` (only spec-doc mentions remain). The `optedOutRows`/`optedOutErr`/`optedOutUserIds` block and both `&& !optedOutUserIds.has(u)` filter usages are gone.
- **eod-reminder-cron/index.ts** — the two `toRemind` filters are now clean:
  - EOD track: `[...storeUsers].filter((u) => !alreadyPushed.has(u))` (line 233).
  - Vendor track: `[...storeUsers].filter((u) => !alreadyPushed.has(u))` (line 294).
- **weekly-reminder-cron/index.ts** — single `toRemind` filter clean: `[...storeUsers].filter((u) => !alreadyReminded.has(u))` (line 283). No dangling block above it (previous location, ~lines 230-237, is gone).
- **Everything else intact, per §4/§5:**
  - Email fallback (`deliverReminder` → `sendPushAll` → Resend on `!sentAny`) preserved in both — a targeted user with zero working push subs still gets the email (eod 174-183, weekly 207-216). Acceptance criterion "email fallback preserved" holds.
  - Eligible-user set (`eligibleUsersForStore` = store members ∪ admins) unchanged (eod 208-209, weekly 242-243). No audience widening.
  - Shared-bearer gate (`expectedBearer` via `_edge_auth`/`cron_bearer`, checked at eod 122-127 / weekly 155-160) untouched.
  - `escapeHtml` still present and applied on the weekly cron's HTML body (weekly 34-41, 301-302). The eod cron's pre-existing un-escaped store-name interpolation (eod 241, 302) was correctly left alone — out of scope per §5.
- **`verify_jwt = false` intact** for both in `config.toml` (eod 439, weekly 442). config.toml was not touched; the shared-bearer documentation block (430-437) is preserved.
- **No migration added/removed** — `db-migrations-applied` gate unaffected. Historical `20260427023804_notifications_enabled.sql` remains inert as designed; `20260502071736_remote_schema.sql:145` already dropped the column in prod.

## 2. Frontend contract — MATCHES

- **`src/lib/notificationState.ts` `deriveNotificationState`** implements the exact 6-branch precedence from design §2, in order: (1) `probeError → 'error'`, (2) `isIos && !isStandalone → 'needs-install'`, (3) `!capable → 'unsupported'`, (4) `permission==='denied' → 'denied'`, (5) `granted && hasSubscription → 'on'`, (6) else `'off'`. The iOS-tab-before-unsupported ordering (the load-bearing subtlety) is present and comment-documented. `DeriveInput`/`NotificationView` shapes match §1 verbatim.
- **`subscribeCodeToMessageKey`** covers all 8 `SubscribeResult` codes → 5 suffixes per §3, with a `never` exhaustiveness guard so a future code fails at compile time. Matches the §3 table exactly (incl. `no-user → generic`).
- **`probeNotificationState` / `detectIos`** are the impure collectors as specified (isWebPushCapable semantics, `Notification.permission`, `getRegistration()?.pushManager.getSubscription()` in try/catch → `probeError`, `navigator.standalone || matchMedia('(display-mode: standalone)')`, iPadOS-13+ masquerade). Off-web resolves to `capable:false`.
- **Both components wire this-device-only correctly:** ON → `requestPermissionAndSubscribe(userId)` from the press handler; OFF → `unsubscribeFromPush()`; both re-probe after. No other endpoint/device row is touched (endpoint-keyed upsert/delete owned by `webPush.ts`). Staff reads id via `currentStaffUserId(authState)`; admin via `useStore((s) => s.currentUser?.id)`. Mounts land where designed: staff `NotificationSwitcher` in StorePicker `switcherRow` after `<ScaleSwitcher />` (StorePicker.tsx:59); admin `NotificationToggle` in `ResponsiveCmdShell` `railFooter` adjacent `<LocaleSwitcher />` (line 281).
- **No new data-model, RPC, or db.ts surface** was introduced — confirmed. The components import `webPush.ts` helpers directly (sanctioned carve-out); no db.ts wrapper was added, as instructed. No new store slice; source of truth is the live browser with a `visibilitychange` re-probe (matches the "optimistic-then-revert does not apply" note in the design).
- **i18n:** `chrome.notifications` block present in all 6 catalogs (staff + cmd × en/es/zh-CN) with the full key set (`label`, `aria`, `state.{on,off}`, `iosInstall.{title,steps}`, `msg.{unsupported,misconfigured,denied,dismissed,generic}`, `retry`). Components reference `chrome.notifications.*` consistently.
- **Tests:** `notificationState.test.ts` exercises all six reducer branches (incl. iOS-tab-before-unsupported and installed-iOS-PWA fall-through) plus the full 8-code map — meets the §Tests minimum.

## 3. The five orphaned `notifications_enabled` references — LEFT UNTOUCHED (correct)

All five flagged in design §0 remain exactly as-was; no silent scope expansion:

| Reference | Location | Status |
|---|---|---|
| `updateProfileNotifications()` dead writer | `src/lib/db.ts:2163` | untouched |
| defensive read `!== false` | `src/lib/auth.ts:198` | untouched |
| defensive read `!== false` | `src/lib/auth.ts:642` | untouched |
| defensive read `!== false` | `src/lib/db.ts:4479` | untouched |
| `User.notificationsEnabled?: boolean` type | `src/types/index.ts:56` | untouched |

(Plus the two test fixtures at `auth.fetchAllUsers.test.ts:84` / `db.fetchBrandAdmins.test.ts:79` and the benign `db.ts:4514` default-map `notificationsEnabled: true` — all still inert.)

**Restated disposition:** These remain a **benign hygiene follow-up, NOT a now-warranted cleanup for this PR.** Nothing changed about their risk profile: the reads still default to `true` (column absent ⇒ `undefined !== false`), and the writer is still never called. The cron no longer reading the column does not make the frontend orphans newly dangerous — it only removes the last *active* consumer of the absent column. Folding the deletion into 118 would violate "ask before expanding scope" and would bloat what is a clean drift-removal + UI diff. Recommend a dedicated follow-up spec to delete `updateProfileNotifications`, the `notificationsEnabled` type field, the two auth.ts reads, and the db.ts read in one pass. Leaving them is the right call for 118.

---

## Minor findings (informational)

- **M1 (by design).** iOS `detectIos()` UA-sniffing is brittle (Apple can change UA/masquerade heuristics). Mitigated exactly as the design called for: it feeds the pure reducer and is swappable in one place; the reducer branch is unit-tested. No action.
- **M2 (pre-existing, out of scope).** eod-reminder-cron still interpolates the store name into its HTML email body un-escaped (lines 241, 302), unlike the weekly cron which uses `escapeHtml`. This is a pre-existing gap the design explicitly excluded from 118 to keep the diff a clean drift-removal. Flag for a future escaping-parity spec; do not fix here.
- **M3 (verification gap, non-blocking).** The developer noted `preview_*` browser tooling was unavailable, so the two rendered toggles were not smoke-tested in a live browser (both mount points sit behind auth). Reducer + catalog-parity + full tsc/jest are green (102 suites / 1184 tests per the spec). A manual in-browser smoke of both toggles is recommended before release, but this is a QA step, not architectural drift.

---

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 3 Minor
  (all by-design / pre-existing / QA-step). Implementation matches the Spec 118
  backend design: both crons are clean of notifications_enabled/optedOut with
  email fallback, eligible-user set, shared-bearer gate, verify_jwt=false, and
  escapeHtml intact and no migration/realtime change; the frontend reducer, code
  map, components, mounts, i18n, and tests match the contract; and the five
  orphaned notifications_enabled references were correctly left untouched
  (benign follow-up, not a now-warranted cleanup).
payload_paths:
  - specs/118-pwa-notification-toggle/reviews/backend-architect.md
