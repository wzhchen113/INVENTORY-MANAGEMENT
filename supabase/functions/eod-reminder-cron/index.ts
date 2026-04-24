// EOD + vendor-order reminder cron.
//
// Two reminder tracks per cron tick:
//  (1) EOD count per store  — fires at 60/30/10 min before store.eod_deadline_time
//  (2) Vendor order cutoff   — fires at 60/30/10 min before vendor.order_cutoff_time
//                             ONLY on days where order_schedule has (store, vendor)
//                             AND no purchase_order for (store, vendor) has been placed today
//
// Eligible user set for either track for a given store: user_stores ∪ admins/masters.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const BUCKETS = [60, 30, 10] as const;
const TOLERANCE_MIN = 2.5;

type Store = { id: string; name: string; eod_deadline_time: string | null };
type Vendor = { id: string; name: string; order_cutoff_time: string | null };
type SchedRow = { store_id: string; vendor_id: string };
type Sub = { user_id: string; endpoint: string; p256dh: string; auth: string };

function nowPartsInTZ(tz: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
}

function minutesUntilCutoff(cutoffHHMM: string, tz: string) {
  const parts = nowPartsInTZ(tz);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const [ch, cm] = cutoffHHMM.split(':').map(Number);
  const cutoffMinutes = ch * 60 + cm;
  return { minutes: cutoffMinutes - localMinutes, localDate, weekday: parts.weekday };
}

function inWindow(minutesUntil: number, bucket: number) {
  return Math.abs(minutesUntil - bucket) <= TOLERANCE_MIN;
}

async function sendPushAll(
  sb: any, webpush: any, userSubs: Sub[], payload: string,
): Promise<{ sentAny: boolean; errors: any[] }> {
  let sentAny = false;
  const errors: any[] = [];
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
      errors.push({ statusCode, message: e?.message });
    }
  }
  return { sentAny, errors };
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
    if (storesErr) return new Response(JSON.stringify({ ok: false, error: `stores: ${storesErr.message}` }), { status: 500 });

    const { data: adminRows, error: adminErr } = await sb
      .from('profiles').select('id').in('role', ['admin', 'master']);
    if (adminErr) return new Response(JSON.stringify({ ok: false, error: `admins: ${adminErr.message}` }), { status: 500 });
    const adminUserIds = new Set((adminRows || []).map((r: any) => r.id as string));

    // Pre-fetch all user_stores and all push_subscriptions once for efficiency.
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

    // ─── TRACK 1: EOD count per store ────────────────────────────────────
    for (const store of (stores || []) as Store[]) {
      const cutoff = store.eod_deadline_time || '22:00';
      const { minutes, localDate } = minutesUntilCutoff(cutoff, DEFAULT_TZ);
      const bucket = BUCKETS.find((b) => inWindow(minutes, b));
      if (!bucket) continue;

      const storeUsers = eligibleUsersForStore(store.id);
      if (storeUsers.size === 0) continue;

      const { data: submittedRows } = await sb.from('eod_submissions').select('submitted_by').eq('store_id', store.id).eq('date', localDate);
      const submitted = new Set((submittedRows || []).map((r: any) => r.submitted_by as string));

      const { data: logRows } = await sb.from('eod_reminder_log').select('user_id').eq('store_id', store.id).eq('local_date', localDate).eq('bucket', bucket);
      const alreadyPushed = new Set((logRows || []).map((r: any) => r.user_id as string));

      const toRemind = [...storeUsers].filter((u) => !submitted.has(u) && !alreadyPushed.has(u));
      if (toRemind.length === 0) continue;

      let pushed = 0;
      for (const userId of toRemind) {
        const msg = `EOD count — ${bucket} min left. Submit for ${store.name} (cutoff ${cutoff}).`;
        const payload = JSON.stringify({
          title: `EOD count — ${bucket} min left`,
          body: `Submit your count for ${store.name}. Cutoff at ${cutoff}.`,
          tag: `eod-${store.id}-${localDate}`, url: '/',
        });
        const { sentAny } = await sendPushAll(sb, webpush, subsByUser.get(userId) || [], payload);
        await sb.from('in_app_notifications').insert({ user_id: userId, message: msg });
        if (sentAny) {
          pushed++;
          await sb.from('eod_reminder_log').insert({
            user_id: userId, store_id: store.id, local_date: localDate, bucket,
          });
        }
      }
      summary.eod.push({ storeName: store.name, bucket, minutesUntil: minutes, toRemind: toRemind.length, pushed });
    }

    // ─── TRACK 2: Vendor order cutoff ────────────────────────────────────
    const { weekday } = minutesUntilCutoff('00:00', DEFAULT_TZ); // just to fetch weekday
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

        // Skip if the order's already been placed today for this (store, vendor)
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

        let pushed = 0;
        for (const userId of toRemind) {
          const msg = `${vendor.name} order — ${bucket} min left. Submit ${vendor.name} order for ${store.name} (cutoff ${vendor.order_cutoff_time}).`;
          const payload = JSON.stringify({
            title: `${vendor.name} order — ${bucket} min left`,
            body: `Submit ${vendor.name} order for ${store.name}. Cutoff at ${vendor.order_cutoff_time}.`,
            tag: `vendor-${row.store_id}-${row.vendor_id}-${localDate}`, url: '/',
          });
          const { sentAny } = await sendPushAll(sb, webpush, subsByUser.get(userId) || [], payload);
          await sb.from('in_app_notifications').insert({ user_id: userId, message: msg });
          if (sentAny) {
            pushed++;
            await sb.from('vendor_reminder_log').insert({
              user_id: userId, store_id: row.store_id, vendor_id: row.vendor_id,
              local_date: localDate, bucket,
            });
          }
        }
        summary.vendor.push({ storeName: store.name, vendorName: vendor.name, bucket, minutesUntil: minutes, toRemind: toRemind.length, pushed });
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
