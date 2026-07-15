// Spec 120 — on-submission push fan-out.
//
// Event-driven, NOT a user-invoked privileged op: verify_jwt=false in
// config.toml + a shared-bearer gate validated here (same posture as
// eod-reminder-cron / weekly-reminder-cron). No ADMIN_ROLES gate applies.
//
// pg (public.enqueue_submission_push, SECURITY DEFINER) fires net.http_post to
// this function with { notification_id } and Authorization: Bearer <cron_bearer>
// AFTER the submission commits. Given the notification, we resolve recipients =
//   role = 'super_admin'                                (all brands)
//   OR (role in ('admin','master') AND brand_id = notif.brand_id)  (own brand)
//   MINUS the actor_user_id                             (never the submitter)
// then push to their push_subscriptions via the spec-118 VAPID path.
//
// Email fallback intentionally omitted per spec 120 Q4; flag-gated follow-up.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

type Sub = { user_id: string; endpoint: string; p256dh: string; auth: string };

// Human-facing type labels for the push title.
const TYPE_LABEL: Record<string, string> = {
  eod: 'EOD count',
  weekly: 'Weekly count',
  waste: 'Waste log',
  receiving: 'Delivery received',
  po: 'Purchase order',
};

// ─── sendPushAll — copied VERBATIM from eod-reminder-cron/index.ts:57 ──
// 404/410 → prune the dead subscription. Do not diverge from the reference.
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

// Shared-bearer gate — mirrors eod-reminder-cron. pg reads cron_bearer from
// public._edge_auth (RLS-locked, service_role-only) and sends it; we do the
// same lookup via service_role and compare. Anon callers cannot read the table
// so they cannot forge the token.
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
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing: VAPID_PUBLIC/VAPID_PRIVATE' }), { status: 500 });
    }
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, error: `setVapidDetails: ${e?.message || e}` }), { status: 500 });
    }

    let body: any = {};
    try { body = await req.json(); } catch { /* empty body → 400 below */ }
    const notificationId = body?.notification_id as string | undefined;
    if (!notificationId) {
      return new Response(JSON.stringify({ ok: false, error: 'notification_id required' }), { status: 400 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Load the notification (service_role bypasses RLS).
    const { data: notif, error: notifErr } = await sb
      .from('notifications')
      .select('id, brand_id, type, actor_user_id, actor_name, store_name')
      .eq('id', notificationId)
      .single();
    if (notifErr || !notif) {
      return new Response(JSON.stringify({ ok: false, error: `notification not found: ${notifErr?.message || 'null'}` }), { status: 404 });
    }

    // Recipients: all super_admin (any brand) + admin/master of the notif's
    // brand, MINUS the actor. Two queries then union (the OR spans a
    // brand-scoped and an unscoped arm — simpler as two reads).
    const recipients = new Set<string>();
    const { data: supers, error: supErr } = await sb
      .from('profiles').select('id').eq('role', 'super_admin');
    if (supErr) return new Response(JSON.stringify({ ok: false, error: `supers: ${supErr.message}` }), { status: 500 });
    for (const r of (supers || []) as any[]) recipients.add(r.id as string);

    const { data: brandAdmins, error: baErr } = await sb
      .from('profiles').select('id').in('role', ['admin', 'master']).eq('brand_id', notif.brand_id);
    if (baErr) return new Response(JSON.stringify({ ok: false, error: `brandAdmins: ${baErr.message}` }), { status: 500 });
    for (const r of (brandAdmins || []) as any[]) recipients.add(r.id as string);

    // Never push the submitter.
    if (notif.actor_user_id) recipients.delete(notif.actor_user_id as string);

    if (recipients.size === 0) {
      return new Response(JSON.stringify({ ok: true, recipients: 0, pushed: 0 }), { headers: { 'content-type': 'application/json' } });
    }

    // Their push_subscriptions. push_subscriptions.user_id is text; profiles.id
    // is uuid — the .in() cast is implicit (the reminder cron relies on the same).
    const userIds = [...recipients];
    const { data: subRows } = await sb
      .from('push_subscriptions').select('user_id, endpoint, p256dh, auth').in('user_id', userIds);
    const subsByUser = new Map<string, Sub[]>();
    for (const s of (subRows || []) as Sub[]) {
      if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
      subsByUser.get(s.user_id)!.push(s);
    }

    const label = TYPE_LABEL[notif.type as string] ?? 'Submission';
    const payload = JSON.stringify({
      title: `${label} submitted`,
      body: `${notif.actor_name ?? 'A user'} · ${notif.store_name ?? ''}`.trim(),
      tag: `notif-${notif.id}`,
      url: '/',
    });

    let pushedUsers = 0;
    for (const userId of userIds) {
      const subs = subsByUser.get(userId) || [];
      if (subs.length === 0) continue;
      const { sentAny } = await sendPushAll(sb, webpush, subs, payload);
      if (sentAny) pushedUsers++;
    }

    // email fallback intentionally omitted per spec 120 Q4; flag-gated follow-up.

    return new Response(JSON.stringify({ ok: true, recipients: recipients.size, pushed: pushedUsers }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false, error: `uncaught: ${e?.message || String(e)}`, stack: e?.stack?.slice(0, 600),
    }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
