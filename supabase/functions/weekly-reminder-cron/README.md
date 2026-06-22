# weekly-reminder-cron

Spec 098. Edge function that fires daily from `pg_cron` and, for each active
store whose `weekly_count_due_dow` matches the store-local business weekday,
reminds eligible staff (store members ∪ admins) that the **weekly full-store
inventory count** is due — via Web Push, with an email fallback (Resend) and an
`in_app_notifications` row. The in-app banner (driven by `weekly_count_status`)
is the reliable floor; push is best-effort.

Reminders fire **at most once per store per week**, deduped server-side via
`public.weekly_reminder_log` `unique (user_id, store_id, week_start)`.

## Auth posture

`verify_jwt = false` (see `supabase/config.toml`). This is a cross-store cron
reader invoked by `pg_cron` with a **shared bearer**, not a per-user JWT. The
function validates the shared bearer itself against `public._edge_auth`
(`cron_bearer`), exactly like `eod-reminder-cron`. No `ADMIN_ROLES` role gate is
needed (not user-invoked; no privileged role-change/deletion).

## Prerequisites

1. Migrations applied:
   - `20260622090000_weekly_count_kind_and_cadence.sql` (kind widen + cadence
     column + `submit_weekly_count` + `weekly_count_status`)
   - `20260622090100_weekly_reminder_log.sql` (dedup table)
2. VAPID keys generated: `npx web-push generate-vapid-keys`
3. `pg_cron` + `pg_net` extensions enabled (Database → Extensions)
4. `public._edge_auth` has a `cron_bearer` row (shared by eod-reminder-cron)

## Set secrets

| Name               | Value                                |
|--------------------|--------------------------------------|
| `VAPID_PUBLIC`     | VAPID public key                     |
| `VAPID_PRIVATE`    | VAPID private key                    |
| `VAPID_SUBJECT`    | `mailto:admin@your-domain.example`   |
| `DEFAULT_TIMEZONE` | e.g. `America/New_York`              |
| `RESEND_API_KEY`   | (optional) email fallback            |
| `RESEND_FROM_ADDRESS` | (optional) verified sender        |

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected.)

## Deploy

```bash
supabase functions deploy weekly-reminder-cron --no-verify-jwt
```

## Schedule

Apply `supabase/scripts/weekly-reminder-cron.sql` in the Dashboard SQL editor
(manual-prod-only; `supabase db reset` ignores `supabase/scripts/`). The cron
runs **daily** and the function self-filters to each store's due weekday — a
weekly cron can't know each store's due day, and at-most-once is enforced by
`weekly_reminder_log`, not the schedule.

## Smoke

`bash scripts/smoke-weekly-reminder.sh` — asserts the shared-bearer 403 gate,
a sane `{ ok, summary.weekly }` envelope, and the once-per-store-per-week dedup
(second same-week invocation reminds 0).
