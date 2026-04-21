// supabase/functions/eod-reminder-cron/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// EOD reminder cron — fires every 5 min from pg_cron, decides whether a
// reminder (60 / 30 / 10 min before each store's EOD cutoff) needs to go out,
// and sends Web Push messages to the user's registered devices.
//
// Deduplicates via `eod_reminder_log`, so overlapping cron fires within the
// tolerance window don't resend the same bucket.
//
// Required secrets (Supabase → Project Settings → Edge Functions → Secrets):
//   VAPID_PUBLIC      — generated via `npx web-push generate-vapid-keys`
//   VAPID_PRIVATE     — keep secret, never expose to the client
//   VAPID_SUBJECT     — "mailto:you@example.com" (contact for Push services)
//   DEFAULT_TIMEZONE  — fallback if a store has no timezone column (e.g. "America/New_York")
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
const DEFAULT_TZ = Deno.env.get('DEFAULT_TIMEZONE') ?? 'America/New_York';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const BUCKETS = [60, 30, 10] as const;
const TOLERANCE_MIN = 2.5; // cron fires every 5 min; center each bucket ±2.5 min

type Store = {
  id: string;
  name: string;
  eod_deadline_time: string | null;
};

type Sub = { user_id: string; endpoint: string; p256dh: string; auth: string };

function minutesUntilCutoff(cutoffHHMM: string, tz: string) {
  // Current wall-clock in the target tz (extracted via Intl parts).
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const [ch, cm] = cutoffHHMM.split(':').map(Number);
  const cutoffMinutes = ch * 60 + cm;
  return { minutes: cutoffMinutes - localMinutes, localDate };
}

function inWindow(minutesUntil: number, bucket: number) {
  return Math.abs(minutesUntil - bucket) <= TOLERANCE_MIN;
}

Deno.serve(async (_req) => {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Pull all active stores. Timezone is app-global (DEFAULT_TIMEZONE env var),
  // not per-store — add a `timezone` column on stores later if you ever expand
  // to locations in multiple time zones.
  const { data: stores, error: storesErr } = await sb
    .from('stores')
    .select('id, name, eod_deadline_time')
    .eq('status', 'active');
  if (storesErr) {
    console.error('stores fetch failed:', storesErr);
    return new Response(JSON.stringify({ ok: false, error: storesErr.message }), { status: 500 });
  }

  const summary: Array<Record<string, unknown>> = [];

  for (const store of (stores || []) as Store[]) {
    const cutoff = store.eod_deadline_time || '22:00';
    const tz = DEFAULT_TZ;
    const { minutes, localDate } = minutesUntilCutoff(cutoff, tz);

    // Which bucket is this cron tick in range of (if any)?
    const bucket = BUCKETS.find((b) => inWindow(minutes, b));
    if (!bucket) continue;

    // Who belongs to this store?
    const { data: userRows, error: usErr } = await sb
      .from('user_stores')
      .select('user_id')
      .eq('store_id', store.id);
    if (usErr) { console.error('user_stores err:', usErr); continue; }
    const storeUsers = new Set((userRows || []).map((r: any) => r.user_id as string));
    if (storeUsers.size === 0) continue;

    // Who already submitted EOD for this store today (local date)?
    const { data: submittedRows, error: subErr } = await sb
      .from('eod_submissions')
      .select('submitted_by')
      .eq('store_id', store.id)
      .eq('date', localDate);
    if (subErr) { console.error('eod_submissions err:', subErr); continue; }
    const submitted = new Set((submittedRows || []).map((r: any) => r.submitted_by as string));

    // Who have we already pushed this bucket to today?
    const { data: logRows, error: logErr } = await sb
      .from('eod_reminder_log')
      .select('user_id')
      .eq('store_id', store.id)
      .eq('local_date', localDate)
      .eq('bucket', bucket);
    if (logErr) { console.error('reminder_log err:', logErr); continue; }
    const alreadyPushed = new Set((logRows || []).map((r: any) => r.user_id as string));

    const toRemind = [...storeUsers].filter((u) => !submitted.has(u) && !alreadyPushed.has(u));
    if (toRemind.length === 0) continue;

    // Fetch push subscriptions for the users who need a reminder.
    const { data: subs, error: psErr } = await sb
      .from('push_subscriptions')
      .select('user_id, endpoint, p256dh, auth')
      .in('user_id', toRemind);
    if (psErr) { console.error('push_subs err:', psErr); continue; }

    const byUser = new Map<string, Sub[]>();
    for (const s of (subs || []) as Sub[]) {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
      byUser.get(s.user_id)!.push(s);
    }

    for (const userId of toRemind) {
      const userSubs = byUser.get(userId) || [];
      let sentAny = false;
      for (const s of userSubs) {
        const payload = JSON.stringify({
          title: `EOD count — ${bucket} min left`,
          body: `Submit your count for ${store.name}. Cutoff at ${cutoff}.`,
          tag: `eod-${store.id}-${localDate}`,
          url: '/',
        });
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          sentAny = true;
        } catch (e: any) {
          // 404/410 = subscription gone; clean up.
          const statusCode = e?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
          } else {
            console.error('webpush send error:', statusCode, e?.body || e?.message);
          }
        }
      }
      if (sentAny) {
        // Record the send so the next cron within the tolerance window doesn't resend.
        await sb.from('eod_reminder_log').insert({
          user_id: userId,
          store_id: store.id,
          local_date: localDate,
          bucket,
        });
      }
    }

    summary.push({
      storeId: store.id, storeName: store.name, bucket, minutesUntil: minutes,
      localDate, pushed: toRemind.length,
    });
  }

  return new Response(JSON.stringify({ ok: true, summary }), {
    headers: { 'content-type': 'application/json' },
  });
});
