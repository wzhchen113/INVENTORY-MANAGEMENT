// Weekly full-store inventory-count reminder cron (spec 098).
//
// Fires daily from pg_cron; for each active store with a configured
// `weekly_count_due_dow`, when TODAY (store-local business date) is the
// due day AND the store has no weekly count in the current week window,
// it reminds eligible staff (store members ∪ admins) via web push, with
// an email fallback and an in_app_notifications row.
//
// At most once per store per week: deduped server-side via
// public.weekly_reminder_log unique (user_id, store_id, week_start).
//
// Auth posture: verify_jwt = false (config.toml). This is a cross-store
// cron reader invoked by pg_cron with a shared bearer — NOT a per-user
// JWT. The function validates the shared bearer itself via the
// _edge_auth / cron_bearer lookup (same as eod-reminder-cron). No
// ADMIN_ROLES role gate is needed (not user-invoked, no privileged
// role-change/deletion op).
//
// HTML email bodies escape every interpolated value via escapeHtml()
// per the CLAUDE.md HTML-email rule (the EOD cron's un-escaped store-name
// interpolation is a pre-existing gap NOT replicated here).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const BUSINESS_DAY_ROLLOVER_HOURS = 3;
const APP_URL = 'https://hopeful-lewin.vercel.app';

type Store = { id: string; name: string; weekly_count_due_dow: number | null };
type Sub = { user_id: string; endpoint: string; p256dh: string; auth: string };

// Five-character HTML escape (& < > " '), per the CLAUDE.md HTML-email
// rule. Inline, not shared — supabase deploys one function at a time, so
// a shared _shared/ module is invisible drift surface.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const WEEKDAY_LABELS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

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

// Business-day date + weekday (0=Sun..6=Sat) for "now minus 3 hours" so a
// post-midnight cron fire still attributes to the prior business day,
// matching the EOD cron and the client's local convention.
function businessTodayInTZ(tz: string) {
  const shifted = new Date(Date.now() - BUSINESS_DAY_ROLLOVER_HOURS * 3_600_000);
  const parts = wallPartsInTZ(tz, shifted);
  const dow = WEEKDAY_LABELS.indexOf(parts.weekday as (typeof WEEKDAY_LABELS)[number]);
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    dow, // 0=Sunday .. 6=Saturday — JS getDay() / extract(dow) parity
  };
}

// Window start (canonical week_start) for the as-of local date + due-dow.
// Mirrors the SQL weekly_count_status math (design §3):
//   days_since_due = (asOfDow - dueDow + 7) % 7
//   window_end     = asOfDate - days_since_due
//   window_start   = window_end - 6
// localDate is YYYY-MM-DD; we do the date arithmetic in UTC noon to avoid
// DST edge shifts, then re-format as YYYY-MM-DD.
function weekWindow(localDate: string, asOfDow: number, dueDow: number) {
  const [y, m, d] = localDate.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const daysSinceDue = ((asOfDow - dueDow + 7) % 7);
  const end = new Date(base.getTime() - daysSinceDue * 86_400_000);
  const start = new Date(end.getTime() - 6 * 86_400_000);
  const fmt = (dt: Date) =>
    `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  return { windowStart: fmt(start), windowEnd: fmt(end) };
}

async function sendPushAll(
  sb: any, wp: any, userSubs: Sub[], payload: string,
): Promise<{ sentAny: boolean }> {
  let sentAny = false;
  for (const s of userSubs) {
    try {
      await wp.sendNotification(
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
// (RLS-locked, service_role-only) and sends it as Authorization. The
// function does the same lookup via service_role and compares. Anon-key
// callers cannot read the table, so they cannot forge the token.
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
      .from('stores').select('id, name, weekly_count_due_dow')
      .eq('status', 'active');
    if (storesErr) return new Response(JSON.stringify({ ok: false, error: `stores: ${storesErr.message}` }), { status: 500 });

    const { data: adminRows, error: adminErr } = await sb
      .from('profiles').select('id').in('role', ['admin', 'master']);
    if (adminErr) return new Response(JSON.stringify({ ok: false, error: `admins: ${adminErr.message}` }), { status: 500 });
    const adminUserIds = new Set((adminRows || []).map((r: any) => r.id as string));

    // Per-user notifications kill switch — excluded from BOTH push and
    // email. Missing/NULL column treated as enabled (matches client default).
    const { data: optedOutRows, error: optedOutErr } = await sb
      .from('profiles').select('id').eq('notifications_enabled', false);
    if (optedOutErr) {
      console.warn('[cron] notifications_enabled fetch failed:', optedOutErr.message);
    }
    const optedOutUserIds = new Set((optedOutRows || []).map((r: any) => r.id as string));

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

    const biz = businessTodayInTZ(DEFAULT_TZ);
    const summary: any = { weekly: [] };

    for (const store of (stores || []) as Store[]) {
      const dueDow = store.weekly_count_due_dow;
      // Not scheduled → never reminded.
      if (dueDow === null || dueDow === undefined) continue;
      // v1: remind only ON the due day. The store-local business weekday
      // must equal the configured due-dow.
      if (biz.dow !== dueDow) {
        summary.weekly.push({ storeName: store.name, skipped: 'not_due_today' });
        continue;
      }

      const { windowStart, windowEnd } = weekWindow(biz.localDate, biz.dow, dueDow);

      // Skip if a weekly count already exists in-window for the store.
      // counted_at is timestamptz; compare against the window as a
      // half-open [windowStart, windowEnd+1) range. (The boundary TZ skew
      // is the documented single-TZ assumption; matches the status RPC.)
      const { data: doneRows } = await sb.from('inventory_counts')
        .select('id').eq('store_id', store.id).eq('kind', 'weekly')
        .gte('counted_at', `${windowStart}T00:00:00`)
        .lt('counted_at', `${windowEnd}T23:59:59.999`)
        .limit(1);
      if (doneRows && doneRows.length > 0) {
        summary.weekly.push({ storeName: store.name, weekStart: windowStart, skipped: 'already_completed' });
        continue;
      }

      const storeUsers = eligibleUsersForStore(store.id);
      if (storeUsers.size === 0) continue;

      // Already-reminded users this week (week_start = windowStart).
      const { data: logRows } = await sb.from('weekly_reminder_log')
        .select('user_id').eq('store_id', store.id).eq('week_start', windowStart);
      const alreadyReminded = new Set((logRows || []).map((r: any) => r.user_id as string));

      const toRemind = [...storeUsers].filter((u) => !alreadyReminded.has(u) && !optedOutUserIds.has(u));
      if (toRemind.length === 0) {
        summary.weekly.push({ storeName: store.name, weekStart: windowStart, skipped: 'all_reminded' });
        continue;
      }

      const dueLabel = WEEKDAY_LABELS[dueDow] ?? 'today';
      let pushed = 0, emailed = 0;
      for (const userId of toRemind) {
        const pushTitle = 'Weekly inventory count due';
        const pushBody = `The weekly full count for ${store.name} is due today (${dueLabel}).`;
        const payloadJson = JSON.stringify({
          title: pushTitle,
          body: pushBody,
          tag: `weekly-${store.id}-${windowStart}`,
          url: '/',
        });
        // HTML email body — every interpolated value escaped.
        const emailHtml = `<p><strong>${escapeHtml(pushBody)}</strong></p>`
          + `<p>Open the app to submit: <a href="${APP_URL}">${escapeHtml(APP_URL)}</a></p>`;

        const result = await deliverReminder(
          userId, subsByUser.get(userId) || [], payloadJson,
          `${pushTitle} (${store.name})`, emailHtml,
        );
        const msg = `Weekly inventory count due — submit the full count for ${store.name} (due ${dueLabel}).`;
        await sb.from('in_app_notifications').insert({ user_id: userId, message: msg });
        if (result.pushed) pushed++;
        if (result.emailed) emailed++;
        // Insert the dedup row regardless of push/email success — the
        // in-app notification landed and the in-app banner is the floor;
        // re-firing the same week would be spam. At-most-once-per-store-
        // per-week is guaranteed by the unique (user, store, week_start).
        await sb.from('weekly_reminder_log')
          .insert({ user_id: userId, store_id: store.id, week_start: windowStart });
      }
      summary.weekly.push({
        storeName: store.name, weekStart: windowStart,
        toRemind: toRemind.length, pushed, emailed,
      });
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
