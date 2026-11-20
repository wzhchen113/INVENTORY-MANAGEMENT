# Spec 192 — AC-23 manual browser pass

Recorded by frontend-developer, 2026-11-10 (local time; local "today" = Tuesday 2026-11-10, DB clock 2026-11-11 02:17 UTC).

## Setup

- Local stack (`supabase_*_imr-inventory` containers, up 3 weeks), `npx expo start --web --port 8081` (the `expo-web` launch config), started for this pass and stopped afterwards.
- Logged in as `admin@local.test` / `password`, store gate → **Frederick**, EOD count, **BJs** tab (9 items). Frederick has no `order_schedule` rows, so every vendor shows on every day and no day is `rest`.
- **Tooling note.** The `preview_*` tools weren't available to this agent session (not in its tool list, and no tool-search tool to load them). The pass was driven instead through headless Chromium with the repo's own Playwright 1.60 (`@playwright/test`, already a devDependency for the e2e track), from throwaway scripts in the session scratchpad. Nothing was added to the repo. Every step below is real UI interaction against the real dev server and local DB, with DOM reads and screenshots.
- Console errors and HTTP ≥ 400 responses were captured for both runs: **none**. The console only showed the pre-existing require-cycle and deprecation warnings (`EODCountSection ↔ PhoneEodCount` cycle, `shadow*`, `pointerEvents`), which exist on `main`.

## Baseline (before any action)

| | count |
|---|---|
| `eod_submissions` | 24 |
| `eod_entries` | 24 |
| `notifications` | 29 |
| `in_app_notifications` | 30 |
| `audit_log` | 32 |

Frederick `inventory_items` (143 rows): `id, current_stock, eod_remaining, last_updated_by, updated_at` snapshotted to a scratch file for an exact diff. No Frederick submission existed for the last 8 days.

Another session was writing to the same DB around this time (audit and notification rows at 02:14 UTC), so cleanup went by exact row id, not by count.

## Desktop, 1440×900

Items used: A = Caramel Mouse (case 6), B = Carrot Cake 8" (case 10), the first two BJs rows with an enabled case box.

### Run 1 (typed values, no EDIT)

| Step | Observed |
|---|---|
| Tuesday (today) selected | Header **"Tuesday, Nov 10"** |
| Typed A = 1 case, B = 2 cases | "2 of 9 items counted" |
| Picked **Monday** in the week list | Header **"Monday, Nov 9"** (the Tuesday header is gone). A and B **blank**. **"0 of 9 items counted"**. Footer **est. value $0.00** (screenshot `desk-2-d1-blank.png`) |
| SUBMIT COUNT on Monday | Blocked: toast **"Count every item first"**. No write |
| Back to Tuesday | A = 1, B = 2, "2 of 9 items counted" (drafts kept per date, Q1) |
| Monday: marked all 9 NO NEED, SUBMIT COUNT | Toast **"Count submitted · 9 items · 2026-11-09"** (read from the DOM), then the jump to Ordering (D-192-1 plain case: still on the submitted day; screenshot `desk-4-d1-submitted-toast.png` shows the Ordering / Reorder section) |
| DB | One BJs submission **dated 2026-11-09**, 9 entries: **9 no_need, 0 numeric**. Tuesday's 1-case / 2-case values are not in it |

### Run 2 (EDIT)

| Step | Observed |
|---|---|
| Re-entered EOD count, picked Monday | BJs **SUBMITTED · LOCKED**, EDIT button shown |
| EDIT, set A units = 3 | **EDITING** banner, **UPDATE COUNT**, A = 3 |
| Picked **Sunday** (no submission) | **No editing banner, no UPDATE COUNT, SUBMIT COUNT shown**, A blank, **0 NO NEED marks** (Monday's 9 seeded marks didn't follow). Header **"Sunday, Nov 8"** (screenshot `desk-7-d2-not-edit.png`) |
| Back to Monday | EDIT resumes: banner, UPDATE COUNT, A = 3 |

Not submitted, so run 2 wrote nothing.

## Phone, 390×844 (phone tier, `PhoneEodCount`)

Menu → EOD count → BJs. Same items A and B, entered through the units wells and the keypad sheet.

| Step | Observed |
|---|---|
| Header | **"WK 46 · NOV 2026"** (unchanged phone format, AC-16) |
| Tuesday: keypad A = 1, B = 2 | Wells show 1 and 2 |
| Day strip → **Sunday Nov 8** | Wells **"—" / "—"**, button **SUBMIT COUNT** |
| SUBMIT on Sunday | Blocked: **"Count every item first · 9 still need a count"** (screenshot `phone-5-d2-not-edit.png` still shows that toast) |
| Back to Tuesday | Wells 1 and 2 again |
| **Monday Nov 9** (submitted in desktop run 1) | Locked, EDIT button shown |
| EDIT, keypad A → 3 | Button **UPDATE COUNT**, A = 3 |
| Day strip → **Sunday Nov 8** | Button **SUBMIT COUNT**, no EDIT button, A = "—" |
| Back to Monday | **UPDATE COUNT**, A = 3 (EDIT resumed) |

Not submitted at phone width.

## Cleanup

Only this pass's rows, by exact id, in one transaction:

- `eod_entries` × 9 and `eod_submissions` × 1 (`5d1246eb-cb60-4ed4-b5e8-6fe1b83ef773`, BJs, 2026-11-09)
- `notifications` × 1 (`dd16eda8-…`, `order_ready`, `source_id` = that submission; 0 `notification_reads`, 0 `order_approvals` referencing it)
- `in_app_notifications` × 2 (`2862679c-…`, `54bac253-…`, "Local Admin submitted today's EOD count (BJs) for Frederick", the known out-of-scope copy issue)
- `audit_log` × 9 (02:18:59 UTC, user `1111…`, Frederick, "Remaining count submitted · vendor: BJs", value NO NEED)

`inventory_items`: the before/after snapshot diff of all 143 Frederick rows was **empty**. An all-NO NEED submit doesn't move on-hand, so `current_stock`, `eod_remaining`, `last_updated_by` and `updated_at` needed no restore.

After cleanup: 24 / 24 / 29 / 30 / 32, matching the baseline, and 0 `audit_log` rows since the pass started.

## Screenshots (session scratchpad, not committed)

`/private/tmp/claude-501/-Users-will-Documents-GitHub-INVENTORY-MANAGEMENT/66dd49be-334e-4d35-bbe4-df8a044db57f/scratchpad/`:
`desk-1-d0-typed.png`, `desk-2-d1-blank.png`, `desk-3-d1-gate.png`, `desk-4-d1-submitted-toast.png`, `desk-5-d1-locked.png`, `desk-6-d1-edit.png`, `desk-7-d2-not-edit.png`, `desk-8-d1-edit-resumed.png`, `phone-1-d0-typed.png`, `phone-2-d2-blank.png`, `phone-3-d2-gate.png`, `phone-4-d1-edit.png`, `phone-5-d2-not-edit.png`, `phone-6-d1-edit-resumed.png`.

## Not exercised in the browser

- AC-8 / AC-9 (a write in flight across a date change) and the D-192-1 negative case. The request is too fast locally to switch days reliably by hand. Covered in jest with a held promise (`EODCountSection.dateScoped.spec192.test.tsx`, "in-flight submit").
- Store switch (AC-17): jest only.
- No native (Simulator) pass, per the spec.
