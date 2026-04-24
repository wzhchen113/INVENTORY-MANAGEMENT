// Proxy for the breadbot public sales API.
// https://breadbot.duckdns.org/api/v1/public — exposes per-store / per-date
// sales split across pos / delivery / kiosk channels. The raw API key is a
// secret that must not ship in the web bundle, so the client invokes this
// function and we inject Authorization: Bearer on the server side.
//
// Input  (POST body): { storeName: string, date: 'YYYY-MM-DD' }
// Output (200): { rows: Array<{menuItem, qtySold, revenue}>, freshness_by_channel, meta }
// Output (4xx/5xx): { error: string }
//
// Shape of `rows` matches the existing CSV parser's ParsedRow in
// src/screens/POSImportScreen.tsx so the caller can hand it straight to the
// existing preview → confirm → importPOS pipeline. Revenue is 0 because
// breadbot doesn't expose it; reconciliation only reads qtySold.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Our stores.name → breadbot /sales/daily?store=<code>
// Keep in sync with the client-side guard in POSImportScreen.tsx so the
// button is only visible for stores breadbot actually has data for.
const STORE_MAP: Record<string, string> = {
  Frederick: 'frederick',
  Charles: 'charles',
  Towson: 'york', // breadbot's "york" location is what we call "Towson" internally.
};

const DEFAULT_BASE_URL = 'https://breadbot.duckdns.org/api/v1/public';

// Browsers send a CORS preflight (OPTIONS) before the real POST. Without these
// headers the preflight fails with 405 Method Not Allowed and the button in
// POSImportScreen dies with "Failed to send a request to the Edge Function".
// The cron path doesn't need this (server-to-server, no preflight).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};

type BreadbotSaleRow = {
  date: string;
  store_id: string;
  item_name: string;
  channel: string;
  quantity_sold: number;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { status: 200, headers: CORS_HEADERS });
    }
    if (req.method !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
    const BREADBOT_API_KEY = Deno.env.get('BREADBOT_API_KEY');
    const BREADBOT_BASE_URL = Deno.env.get('BREADBOT_BASE_URL') ?? DEFAULT_BASE_URL;

    const missing: string[] = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
    if (!BREADBOT_API_KEY) missing.push('BREADBOT_API_KEY');
    if (missing.length > 0) {
      return json(500, { error: `Missing env: ${missing.join(', ')}` });
    }

    // Verify the caller has a valid Supabase session. The anon client just
    // passes the Authorization header through to GoTrue so non-authenticated
    // callers can't use us as an open proxy to burn the shared API key.
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return json(401, { error: 'Missing Authorization header' });
    }
    const sb = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await sb.auth.getUser();
    if (userErr || !userData?.user) {
      return json(401, { error: 'Invalid session' });
    }

    // Parse + validate the body.
    let body: { storeName?: unknown; date?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      return json(400, { error: 'Body must be JSON' });
    }
    const storeName = typeof body.storeName === 'string' ? body.storeName.trim() : '';
    const date = typeof body.date === 'string' ? body.date.trim() : '';
    if (!storeName) return json(400, { error: 'storeName required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'date must be YYYY-MM-DD' });

    const code = STORE_MAP[storeName];
    if (!code) return json(400, { error: `Store not mapped: ${storeName}` });

    // Call breadbot. /sales/daily returns all items for one (store, date).
    const upstreamUrl = new URL(`${BREADBOT_BASE_URL}/sales/daily`);
    upstreamUrl.searchParams.set('store', code);
    upstreamUrl.searchParams.set('date', date);

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl.toString(), {
        headers: { Authorization: `Bearer ${BREADBOT_API_KEY}` },
      });
    } catch (e: any) {
      console.error('breadbot fetch threw:', e?.message || e);
      return json(502, { error: 'Upstream unreachable' });
    }

    const upstreamText = await upstream.text();
    if (!upstream.ok) {
      console.error('breadbot non-2xx:', upstream.status, upstreamText.slice(0, 300));
      return json(upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status, {
        error: `Breadbot ${upstream.status}`,
      });
    }

    let payload: any;
    try {
      payload = JSON.parse(upstreamText);
    } catch {
      return json(502, { error: 'Breadbot returned non-JSON' });
    }

    const upstreamRows: BreadbotSaleRow[] = Array.isArray(payload?.data) ? payload.data : [];

    // Collapse channels: sum quantity per item_name. POS import tables don't
    // carry a channel column today; the CSV flow was already channel-agnostic.
    const totals = new Map<string, number>();
    for (const r of upstreamRows) {
      const name = (r.item_name || '').trim();
      if (!name) continue;
      const qty = Number(r.quantity_sold) || 0;
      totals.set(name, (totals.get(name) || 0) + qty);
    }

    const rows = Array.from(totals.entries())
      .filter(([, qty]) => qty > 0)
      .map(([menuItem, qtySold]) => ({ menuItem, qtySold, revenue: 0 }))
      .sort((a, b) => b.qtySold - a.qtySold);

    return json(200, {
      rows,
      freshness_by_channel: payload?.meta?.freshness_by_channel ?? null,
      meta: {
        store_code: code,
        date,
        upstream_row_count: upstreamRows.length,
        collapsed_row_count: rows.length,
      },
    });
  } catch (e: any) {
    console.error('fetch-breadbot-sales crashed:', e?.message || e);
    return json(500, { error: 'Internal error' });
  }
});
