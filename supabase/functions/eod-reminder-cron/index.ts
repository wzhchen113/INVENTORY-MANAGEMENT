// EOD + vendor-order reminder cron, with email fallback.
// Business day rolls over at 3 AM local — so a 01:30 AM reminder check on
// what's calendar-Friday still considers the current date to be Thursday for
// EOD / order dedup purposes, matching the client's view.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const BUCKETS = [60, 30, 10] as const;
const TOLERANCE_MIN = 2.5;
const BUSINESS_DAY_ROLLOVER_HOURS = 3;
const APP_URL = 'https://hopeful-lewin.vercel.app';

type Store = { id: string; name: string; eod_deadline_time: string | null };
type Vendor = { id: string; name: string; order_cutoff_time: string | null };
type SchedRow = { store_id: string; vendor_id: string };
type Sub = { user_id: string; endpoint: string; p256dh: string; auth: string };

function wallPartsInTZ(tz: string, at?: Date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at ?? new Date()).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
}

// Business-day date + weekday for "now minus 3 hours" — used for matching
// against eod_submissions.date / purchase_orders.created_at ~today, and for
// order_schedule.day_of_week.
function businessTodayInTZ(tz: string) {
  const shifted = new Date(Date.now() - BUSINESS_DAY_ROLLOVER_HOURS * 3_600_000);
  const parts = wallPartsInTZ(tz, shifted);
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
  };
}

// Wall-clock "minutes until cutoff" — uses the REAL current time in tz, because
// reminder buckets fire against the cutoff time on the wall clock, not against
// the business-day date. Returns the business-day date for dedup purposes.
function minutesUntilCutoff(cutoffHHMM: string, tz: string) {
  const wall = wallPartsInTZ(tz);
  const biz = businessTodayInTZ(tz);
  const localMinutes = Number(wall.hour) * 60 + Number(wall.minute);
  const [ch, cm] = cutoffHHMM.split(':').map(Number);
  const cutoffMinutes = ch * 60 + cm;
  return { minutes: cutoffMinutes - localMinutes, localDate: biz.localDate, weekday: biz.weekday };
}

function inWindow(minutesUntil: number, bucket: number) {
  return Math.abs(minutesUntil - bucket) <= TOLERANCE_MIN;
}

async function sendPushAll(
  sb: any, webpush: any, userSubs: Sub[], payload: string,
): Promise<{ sentAny: boolean }> {
  let sentAny = false;
  for (const s of userSubs) {
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
    }
  }
  return { sentAny };
}

async function sendEmailViaResend(
  apiKey: string, from: string, to: string, subject: string, html: string,
): Promise<boolean> {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error('resend send failed:', r.status, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (e: any) {
    console.error('resend fetch threw:', e?.message || e);
    return false;
  }
}

// Shared-bearer gate. pg_cron reads the token from public._edge_auth
// (RLS-locked, service_role-only) and sends it as Authorization. The function
// does the same lookup via service_role and compares. Anon-key callers cannot
// read the table, so they cannot forge the token.
async function expectedBearer(supabaseUrl: string, serviceRoleKey: string): Promise<string | null> {
  try {
    const sb = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.from('_edge_auth').select('value').eq('name', 'cron_bearer').single();
    if (error || !data?.value) return null;
    return data.value as string;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }), { status: 500 });
  }
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const want = await expectedBearer(SUPABASE_URL, SERVICE_ROLE_KEY);
  if (!want || token !== want) {
    return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403 });
  }
  try {
    const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC');
    const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE');
    const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
    const DEFAULT_TZ = Deno.env.get('DEFAULT_TIMEZONE') ?? 'America/New_York';
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const RESEND_FROM = Deno.env.get('RESEND_FROM_ADDRESS') ?? 'onboarding@resend.dev';

    const missing: string[] = [];
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

    const emailCache = new Map<string, string | null>();
    async function lookupEmail(userId: string): Promise<string | null> {
      if (emailCache.has(userId)) return emailCache.get(userId)!;
      try {
        const { data, error } = await sb.auth.admin.getUserById(userId);
        if (error) { emailCache.set(userId, null); return null; }
        const email = data?.user?.email || null;
        emailCache.set(userId, email);
        return email;
      } catch { emailCache.set(userId, null); return null; }
    }

    async function deliverReminder(
      userId: string,
      userSubs: Sub[],
      payloadJson: string,
      emailSubject: string,
      emailBodyHtml: string,
    ): Promise<{ pushed: boolean; emailed: boolean }> {
      const { sentAny } = await sendPushAll(sb, webpush, userSubs, payloadJson);
      let emailed = false;
      if (!sentAny) {
        if (!RESEND_API_KEY) {
          console.warn(`[email fallback] no RESEND_API_KEY; push failed for user ${userId}`);
        } else {
          const email = await lookupEmail(userId);
          if (email) {
            emailed = await sendEmailViaResend(RESEND_API_KEY, RESEND_FROM, email, emailSubject, emailBodyHtml);
          }
        }
      }
      return { pushed: sentAny, emailed };
    }

    const { data: stores, error: storesErr } = await sb
      .from('stores').select('id, name, eod_deadline_time').eq('status', 'active');
    if (storesErr) return new Response(JSON.stringify({ ok: false, error: `stores: ${storesErr.message}` }), { status: 500 });

    const { data: adminRows, error: adminErr } = await sb
      .from('profiles').select('id').in('role', ['admin', 'master']);
    if (adminErr) return new Response(JSON.stringify({ ok: false, error: `admins: ${adminErr.message}` }), { status: 500 });
    const adminUserIds = new Set((adminRows || []).map((r: any) => r.id as string));

    const { data: usRows } = await sb.from('user_stores').select('user_id, store_id');
    const usersByStore = new Map<string, Set<string>>();
    for (const r of (usRows || []) as any[]) {
      if (!usersByStore.has(r.store_id)) usersByStore.set(r.store_id, new Set());
      usersByStore.get(r.store_id)!.add(r.user_id);
    }
    const { data: subRows } = await sb.from('push_subscriptions').select('user_id, endpoint, p256dh, auth');
    const subsByUser = new Map<string, Sub[]>();
    for (const s of (subRows || []) as Sub[]) {
      if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
      subsByUser.get(s.user_id)!.push(s);
    }
    const eligibleUsersForStore = (storeId: string) =>
      new Set<string>([...(usersByStore.get(storeId) || []), ...adminUserIds]);

    const summary: any = { eod: [], vendor: [] };

    // ─── TRACK 1: EOD count per store (store-level) ─────────────────────
    for (const store of (stores || []) as Store[]) {
      const cutoff = store.eod_deadline_time || '22:00';
      const { minutes, localDate } = minutesUntilCutoff(cutoff, DEFAULT_TZ);
      const bucket = BUCKETS.find((b) => inWindow(minutes, b));
      if (!bucket) continue;

      const { data: submittedRows } = await sb.from('eod_submissions')
        .select('id').eq('store_id', store.id).eq('date', localDate).limit(1);
      if (submittedRows && submittedRows.length > 0) {
        summary.eod.push({ storeName: store.name, bucket, skipped: 'store_submitted' });
        continue;
      }

      const storeUsers = eligibleUsersForStore(store.id);
      if (storeUsers.size === 0) continue;

      const { data: logRows } = await sb.from('eod_reminder_log').select('user_id').eq('store_id', store.id).eq('local_date', localDate).eq('bucket', bucket);
      const alreadyPushed = new Set((logRows || []).map((r: any) => r.user_id as string));

      const toRemind = [...storeUsers].filter((u) => !alreadyPushed.has(u));
      if (toRemind.length === 0) continue;

      let pushed = 0, emailed = 0;
      for (const userId of toRemind) {
        const pushTitle = `EOD count — ${bucket} min left`;
        const pushBody = `Submit your count for ${store.name}. Cutoff at ${cutoff}.`;
        const payloadJson = JSON.stringify({ title: pushTitle, body: pushBody, tag: `eod-${store.id}-${localDate}`, url: '/' });
        const emailHtml = `<p><strong>${pushBody}</strong></p><p>Open the app to submit: <a href="${APP_URL}">${APP_URL}</a></p>`;

        const result = await deliverReminder(userId, subsByUser.get(userId) || [], payloadJson, `${pushTitle} (${store.name})`, emailHtml);
        const msg = `EOD count — ${bucket} min left. Submit for ${store.name} (cutoff ${cutoff}).`;
        await sb.from('in_app_notifications').insert({ user_id: userId, message: msg });
        if (result.pushed) pushed++;
        if (result.emailed) emailed++;
        if (result.pushed || result.emailed) {
          await sb.from('eod_reminder_log').insert({ user_id: userId, store_id: store.id, local_date: localDate, bucket });
        }
      }
      summary.eod.push({ storeName: store.name, bucket, minutesUntil: minutes, toRemind: toRemind.length, pushed, emailed });
    }

    // ─── TRACK 2: Vendor order cutoff (store-level via purchase_orders) ─────────
    const { weekday } = businessTodayInTZ(DEFAULT_TZ);
    const { data: schedRows } = await sb.from('order_schedule')
      .select('store_id, vendor_id').eq('day_of_week', weekday);

    if (schedRows && schedRows.length > 0) {
      const vendorIds = [...new Set((schedRows as SchedRow[]).map((r) => r.vendor_id))];
      const { data: vendorRows } = await sb.from('vendors')
        .select('id, name, order_cutoff_time').in('id', vendorIds);
      const vendorById = new Map((vendorRows || []).map((v: any) => [v.id, v as Vendor]));

      for (const row of schedRows as SchedRow[]) {
        const vendor = vendorById.get(row.vendor_id);
        if (!vendor?.order_cutoff_time) continue;
        const { minutes, localDate } = minutesUntilCutoff(vendor.order_cutoff_time, DEFAULT_TZ);
        const bucket = BUCKETS.find((b) => inWindow(minutes, b));
        if (!bucket) continue;

        const store = (stores || []).find((s: any) => s.id === row.store_id) as Store | undefined;
        if (!store) continue;

        const { data: po } = await sb.from('purchase_orders')
          .select('id').eq('store_id', row.store_id).eq('vendor_id', row.vendor_id)
          .gte('created_at', `${localDate}T00:00:00Z`)
          .lt('created_at', `${localDate}T23:59:59Z`)
          .limit(1);
        if (po && po.length > 0) {
          summary.vendor.push({ storeName: store.name, vendorName: vendor.name, bucket, skipped: 'already_ordered' });
          continue;
        }

        const storeUsers = eligibleUsersForStore(row.store_id);
        if (storeUsers.size === 0) continue;

        const { data: logRows } = await sb.from('vendor_reminder_log').select('user_id')
          .eq('store_id', row.store_id).eq('vendor_id', row.vendor_id)
          .eq('local_date', localDate).eq('bucket', bucket);
        const alreadyPushed = new Set((logRows || []).map((r: any) => r.user_id as string));

        const toRemind = [...storeUsers].filter((u) => !alreadyPushed.has(u));
        if (toRemind.length === 0) continue;

        let pushed = 0, emailed = 0;
        for (const userId of toRemind) {
          const pushTitle = `${vendor.name} order — ${bucket} min left`;
          const pushBody = `Submit ${vendor.name} order for ${store.name}. Cutoff at ${vendor.order_cutoff_time}.`;
          const payloadJson = JSON.stringify({ title: pushTitle, body: pushBody, tag: `vendor-${row.store_id}-${row.vendor_id}-${localDate}`, url: '/' });
          const emailHtml = `<p><strong>${pushBody}</strong></p><p>Open the app to submit: <a href="${APP_URL}">${APP_URL}</a></p>`;

          const result = await deliverReminder(userId, subsByUser.get(userId) || [], payloadJson, `${pushTitle} (${store.name})`, emailHtml);
          const msg = `${vendor.name} order — ${bucket} min left. Submit ${vendor.name} order for ${store.name} (cutoff ${vendor.order_cutoff_time}).`;
          await sb.from('in_app_notifications').insert({ user_id: userId, message: msg });
          if (result.pushed) pushed++;
          if (result.emailed) emailed++;
          if (result.pushed || result.emailed) {
            await sb.from('vendor_reminder_log').insert({
              user_id: userId, store_id: row.store_id, vendor_id: row.vendor_id,
              local_date: localDate, bucket,
            });
          }
        }
        summary.vendor.push({ storeName: store.name, vendorName: vendor.name, bucket, minutesUntil: minutes, toRemind: toRemind.length, pushed, emailed });
      }
    }

    return new Response(JSON.stringify({ ok: true, summary }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false, error: `uncaught: ${e?.message || String(e)}`, stack: e?.stack?.slice(0, 600),
    }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
