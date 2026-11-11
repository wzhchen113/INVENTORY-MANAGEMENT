# Spec 189: manual browser pass (AC-28)

Run by main Claude on 2026-11-09, on the local stack with migration `20261109120000` applied. The real Cmd UI was signed in as admin@local.test on the Frederick store. Database rows were read with psql after each step. All test rows were removed afterwards, and local counts are back to 24 submissions, 24 entries, 29 audit rows and 26 notifications.

| # | Step | Result |
|---|---|---|
| 1 | EDIT reproduction: Restaurant Depot submitted as 1 and 2 cases (6, 8), then EDIT to 3 and 5 cases | **Pass.** 2 entries (18, 20); `current_stock` 18 and 20; `last_updated_by` set. One `eod_update` notification, and `Count updated` audit rows. After a reload the locked screen shows 3 and 5, and the day tile reads 2/143 |
| 1a | EDIT, then UPDATE COUNT with nothing changed (happened by accident) | **Pass.** No `admin_submit_eod` call, no audit row, no notification. Normal success path, with the jump to Ordering |
| 1b | EDIT, blank Lemon Pepper, UPDATE COUNT | **Pass.** Only that row removed. Fries untouched. Lemon Pepper on-hand kept at 20. One `Count cleared · vendor: RESTAURANT DEPOT` audit row with value `20 each` |
| 2 | Draft reproduction: Costco SAVE DRAFT with 1 item, then fill all 6 and SUBMIT | **Pass.** 6 entries for 6 items, status `submitted`. The old code gave 7 |
| 3 | Admin EDIT over a staff submission: manager calls `staff_submit_eod` for Restaurant Depot on 2026-11-08 (2 and 4 cases), then admin EDITs Fries to 1 case | **Pass.** Fries 6 / 1 case; staff's Lemon Pepper row kept (16 / 4); `client_uuid` unchanged; `submitted_by` now the admin; date stays 2026-11-08 |
| 4 | Phone width (375×812): Costco EDIT, Mac n Cheese 1 → 3 on the keypad, UPDATE COUNT | **Pass.** Mac n Cheese 3, the other 5 rows unchanged, 0 duplicate pairs |
| 5 | EDIT with the Desserts pill selected: Chocolate Cake 1 → 2 | **Pass.** Only Chocolate Cake changed. The other 5 categories' rows survived |
| 6 | Forced failure: temporary local trigger raising on Chocolate Cake's insert, then EDIT 2 → 3 | **Pass.** `admin_submit_eod` → 400. Toast "Saved locally only / Cloud save failed". Screen stays in EDIT with the typed 3. Entries, `submitted_at`, on-hand and notifications all unchanged. Trigger dropped afterwards |
| 7 | Reorder list on screen | **Not checked.** Locally no vendor is scheduled for Monday ("No vendors are ordered on Monday"), so the list was empty. The RPC level is covered by pgTAP AC-18 |

## Observed but not in scope

- **Wrong header date:** the worksheet header said "Monday, Nov 9" while Sunday was selected. The admin EDIT still saved to 2026-11-08. This is the spec 192 bug (date leak and header), being worked in its own session.
- **"total 0" on the locked screen:** the locked Restaurant Depot rows show "total 0 bags / total 0 each" under counted values, both before and after this change. It's pre-existing, and the EDIT view shows the right totals.
- **Unchanged by design (D-5):** on the failure path, the client's audit rows and the bell still fire. This step didn't check them separately.
