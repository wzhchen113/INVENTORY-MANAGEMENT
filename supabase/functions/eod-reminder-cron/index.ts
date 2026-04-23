// EOD reminder cron. Phase 4: also inserts into in_app_notifications
// so the bell-icon history works across devices.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const BUCKETS = [60, 30, 10] as const;
const TOLERANCE_MIN = 2.5;

type Store = { id: string; name: string; eod_deadline_time: string | null };
type Sub = { user_id: string; endpoint: string; p256dh: string; auth: string };

function minutesUntilCutoff(cutoffHHMM: string, tz: string) {
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
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC');
    const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE');
    const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
    const DEFAULT_TZ = Deno.env.get('DEFAULT_TIMEZONE') ?? 'America/New_York';

    const missing: string[] = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!VAPID_PUBLIC) missing.push('VAPID_PUBLIC');
    if (!VAPID_PRIVATE) missing.push('VAPID_PRIVATE');
    if (missing.length > 0) {
      return new Response(JSON.stringify({ ok: false, error: `Missing: ${missing.join(', ')}` }), { status: 500 });
    }

    try {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC!, VAPID_PRIVATE!);
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: `setVapidDetails: ${e?.message || e}` }), { status: 500 });
    }

    const sb = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: stores, error: storesErr } = await sb
      .from('stores')
      .select('id, name, eod_deadline_time')
      .eq('status', 'active');
    if (storesErr) {
      return new Response(JSON.stringify({ ok: false, error: `stores fetch: ${storesErr.message}` }), { status: 500 });
    }

    const summary: Array<Record<string, unknown>> = [];

    for (const store of (stores || []) as Store[]) {
      const cutoff = store.eod_deadline_time || '22:00';
      const { minutes, localDate } = minutesUntilCutoff(cutoff, DEFAULT_TZ);
      const bucket = BUCKETS.find((b) => inWindow(minutes, b));
      if (!bucket) continue;

      const { data: userRows } = await sb.from('user_stores').select('user_id').eq('store_id', store.id);
      const storeUsers = new Set((userRows || []).map((r: any) => r.user_id as string));
      if (storeUsers.size === 0) continue;

      const { data: submittedRows } = await sb.from('eod_submissions').select('submitted_by').eq('store_id', store.id).eq('date', localDate);
      const submitted = new Set((submittedRows || []).map((r: any) => r.submitted_by as string));

      const { data: logRows } = await sb.from('eod_reminder_log').select('user_id').eq('store_id', store.id).eq('local_date', localDate).eq('bucket', bucket);
      const alreadyPushed = new Set((logRows || []).map((r: any) => r.user_id as string));

      const toRemind = [...storeUsers].filter((u) => !submitted.has(u) && !alreadyPushed.has(u));
      if (toRemind.length === 0) {
        summary.push({ storeId: store.id, storeName: store.name, bucket, minutesUntil: minutes, localDate, pushed: 0, note: 'no one to remind' });
        continue;
      }

      const { data: subs } = await sb.from('push_subscriptions').select('user_id, endpoint, p256dh, auth').in('user_id', toRemind);
      const byUser = new Map<string, Sub[]>();
      for (const s of (subs || []) as Sub[]) {
        if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
        byUser.get(s.user_id)!.push(s);
      }

      let pushed = 0;
      const sendErrors: any[] = [];
      for (const userId of toRemind) {
        const userSubs = byUser.get(userId) || [];
        const message = `EOD count — ${bucket} min left. Submit for ${store.name} (cutoff ${cutoff}).`;
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
            const statusCode = e?.statusCode;
            if (statusCode === 404 || statusCode === 410) {
              await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
            }
            sendErrors.push({ statusCode, message: e?.message });
          }
        }
        // Always record an in-app notification, even if OS push failed —
        // the bell icon is the user's safety net.
        await sb.from('in_app_notifications').insert({ user_id: userId, message });
        if (sentAny) {
          pushed++;
          await sb.from('eod_reminder_log').insert({
            user_id: userId, store_id: store.id, local_date: localDate, bucket,
          });
        }
      }

      summary.push({
        storeId: store.id, storeName: store.name, bucket, minutesUntil: minutes,
        localDate, toRemindCount: toRemind.length, pushed,
        ...(sendErrors.length > 0 ? { sendErrors } : {}),
      });
    }

    return new Response(JSON.stringify({ ok: true, summary }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false,
      error: `uncaught: ${e?.message || String(e)}`,
      stack: e?.stack?.slice(0, 500),
    }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
