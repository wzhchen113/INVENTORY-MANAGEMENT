# eod-reminder-cron

Edge function that fires every 5 minutes from `pg_cron` and sends Web Push
reminders for the EOD count at 60 / 30 / 10 minutes before each store's
`eod_deadline_time`.

## Prerequisites

1. Migrations applied:
   - `supabase-migration-eod-deadline.sql` (Phase 1)
   - `supabase-migration-push-subscriptions.sql` (Phase 2)
   - `supabase-migration-eod-reminder-log.sql` (Phase 3 — this phase)
2. VAPID keys generated: `npx web-push generate-vapid-keys`
3. `pg_cron` + `pg_net` extensions enabled (Database → Extensions)

## Set secrets

Supabase Dashboard → Project Settings → Edge Functions → Secrets, add:

| Name               | Value                                         |
|--------------------|-----------------------------------------------|
| `VAPID_PUBLIC`     | VAPID public key                              |
| `VAPID_PRIVATE`    | VAPID private key                             |
| `VAPID_SUBJECT`    | `mailto:admin@your-domain.example`            |
| `DEFAULT_TIMEZONE` | e.g. `America/New_York`                       |

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected.)

Or via CLI:
```bash
supabase secrets set VAPID_PUBLIC=... VAPID_PRIVATE=... VAPID_SUBJECT=mailto:... DEFAULT_TIMEZONE=America/New_York
```

## Deploy

### Option A — Supabase CLI (recommended)

```bash
supabase functions deploy eod-reminder-cron --no-verify-jwt
```

`--no-verify-jwt` lets pg_cron call the function with just the service-role
Authorization header (no per-request user JWT).

### Option B — Dashboard (no CLI needed)

1. Dashboard → Edge Functions → **Create a function** → name `eod-reminder-cron`.
2. Paste the contents of `index.ts`.
3. Save & deploy.
4. Under the function's **Settings**, set **Verify JWT** to **off**.

## Schedule via `pg_cron`

Run in SQL Editor (replace `<project-ref>` and `<service-role-key>` with your
values — find them in Project Settings → API):

```sql
-- One-time setup
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule every 5 minutes
SELECT cron.schedule(
  'eod-reminder-cron',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/eod-reminder-cron',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <service-role-key>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
```

To unschedule later:
```sql
SELECT cron.unschedule('eod-reminder-cron');
```

## Testing

1. Set a test store's `eod_deadline_time` to `HH:MM` that's roughly **65 min
   from now** in your local timezone.
2. Wait ~5 min for the next cron fire → OS notification should appear on any
   browser with an active subscription for a user who (a) belongs to the store
   and (b) hasn't submitted EOD today.
3. Check logs: Dashboard → Edge Functions → `eod-reminder-cron` → Logs.
   Each fire returns a JSON `summary` array showing which stores hit a bucket.
4. To force an immediate run: Dashboard → Edge Functions → Invoke, or:
   ```bash
   curl -X POST \
     -H "Authorization: Bearer <service-role-key>" \
     https://<project-ref>.supabase.co/functions/v1/eod-reminder-cron
   ```
5. Reset by deleting the `eod_reminder_log` rows for today:
   ```sql
   DELETE FROM eod_reminder_log WHERE local_date = to_char((now() at time zone 'America/New_York')::date, 'YYYY-MM-DD');
   ```

## How it picks who / when

For each store:
1. Compute `minutesUntil = cutoff - now()` in the store's local timezone.
2. Find whether `|minutesUntil - 60|`, `|- 30|`, or `|- 10|` is ≤ 2.5. If none, skip.
3. From `user_stores`, get everyone with access to the store.
4. Subtract users who already `eod_submissions` for today's local date.
5. Subtract users we've already pushed this bucket for today (`eod_reminder_log`).
6. For everyone remaining, fetch their `push_subscriptions` rows and `webpush.sendNotification()`.
7. Insert a dedup row into `eod_reminder_log`.
8. On a `404`/`410` response from the push service, the subscription is stale
   and gets deleted from `push_subscriptions`.
