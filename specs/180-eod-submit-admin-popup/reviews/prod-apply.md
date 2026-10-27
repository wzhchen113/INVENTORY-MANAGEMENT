# Spec 180: prod apply record

- **Date:** 2026-10-26, 23:02–23:10 EDT. This is after the 21:00–23:00 EOD rush, as the owner chose ("After 23:00 tonight").
- **Applied by:** main Claude, after the owner's explicit go-ahead: "Yes, apply to prod" and "Yes, ship both" (edge function + migration).
- **Project:** `ebwnovzzkwhsdxkpyjka`, via Supabase MCP. The function was deployed with `deploy_edge_function` and the SQL ran through `execute_sql`; `apply_migration` was not used.
- **Runbook:** §9 of the spec. The function goes first because it is backward-compatible, then the migration, then verification.

## Step 1: edge function `submission-push-fanout`

- **Deployed:** version 7 from the working tree, with `verify_jwt = false` (unchanged).
- **Smoke test:** a wrong bearer gets HTTP 403, so the service-token check still holds.
- **What else shipped:** the working-tree copy also contains spec 162's `order_failed` push text ("Order NOT placed"), which had never been deployed. The owner approved shipping both together.
- **New code:** an `eod_update` label and title/body branch ("EOD count updated", then actor · store · vendor). This is mirrored in `src/utils/pushNotificationCopy.ts`.

## Step 2: read-only pre-flight

- **First check (earlier the same evening):**
  - The CHECK had 9 values, including `order_failed`.
  - Triggers present: `eod_submissions_set_submitted_by_trg` and `notify_eod_submission`.
  - Not yet present: the `submission_id` column and the four new functions.
  - `notifications_type_source_uidx` was present.
  - Function owner was `postgres`.
- **Re-check at 23:02:**
  - The `schema_migrations` versions at or after `20261020` were `20261022000000`, `20261023000000`, `20261024000000` and `20261025000000`.
    - `20261027000000` was absent.
    - Spec 179's `20261026100000` was also absent and was NOT applied; it is not part of this spec.
  - `tg_notify_eod_submission` normalized md5 = `6a479ee90e2244a2a7ea47e37f679b02`, which is the spec 149 body.
  - The `submission_id` column did not exist.
  - There were 0 `eod_submissions` with `submitted_at` in the last 10 minutes, so the window was quiet.

## Step 3: apply

- **Migration:** I ran the exact body of `supabase/migrations/20261027000000_eod_update_notifications.sql` (`begin … commit`, `lock_timeout 5s`) through `execute_sql`. It succeeded with no error.
- **Recorded:** `insert into supabase_migrations.schema_migrations (version, name) values ('20261027000000', 'eod_update_notifications')` returned the row.

## Step 4: verification

- **`notifications_type_check`:** now has 10 values, ending `… 'order_ready', 'order_failed', 'eod_update'`.
- **`notifications.submission_id`:** `uuid`, nullable.
- **`notify_eod_resubmission`:** `AFTER UPDATE OF status, submitted_at ON public.eod_submissions FOR EACH ROW WHEN ((new.status = 'submitted'::text)) EXECUTE FUNCTION tg_notify_eod_resubmission()`.
- **`notify_eod_submission`:** unchanged (`AFTER INSERT … WHEN ((new.status = 'submitted'::text))`).
- **Versions at or after `20261020`:** `20261022000000`, `20261023000000`, `20261024000000`, `20261025000000` and `20261027000000`.

Function checks. Every function is owned by `postgres`, and neither `authenticated` nor `anon` can EXECUTE any of them. Each normalized md5 equals the local value:

| function | SECURITY DEFINER | normalized md5 |
|---|---|---|
| `emit_eod_submit_notification` | yes | `acaa4e0e963f429fea1a4529e4cf812a` ✅ |
| `tg_notify_eod_submission` | yes | `a0626735e84124a9731299faa7b71d87` ✅ |
| `emit_eod_update` | yes | `8e95ec794159964fb9f98656b12c48a2` ✅ |
| `eod_update_push_suppressed` | no (invoker) | `8ece6357c329cedf98221df10766091a` ✅ |
| `tg_notify_eod_resubmission` | yes | `4418c8b9ae7eb492714826af9cea47ee` ✅ |

## Step 5: rolled-back smoke test on prod

- **Method:** a `DO` block that ends in `raise exception`, so the whole thing rolls back, including any pg_net queue insert. It used the most recent submitted EOD row.
- **Maintenance UPDATE (no JWT claims):** 0 `eod_update` rows. Guard (G) holds.
- **The same UPDATE with `request.jwt.claims.sub` set to the submitter:** exactly 1 `eod_update` row.
  - `actor_user_id` was the editor.
  - `store_name` was set.
  - `body` was the vendor name ("SYSCO").
- **Afterwards:** 0 `eod_update` rows in `public.notifications`, so nothing persisted.

## Not covered here

- **Live end-to-end checks** (an admin's edit shows a toast for another admin; draft then submit gives exactly one fresh row; a second edit within 60 s pushes nothing) need real accounts and devices. The jest, pgTAP and Playwright suites cover each of these locally (see `test-engineer.md`).
- **Known, deferred:** edit replays from the staff offline queue re-notify, because `client_uuid` is kept on the edit path. This is recorded in `release-proposal.md` as a follow-up.
