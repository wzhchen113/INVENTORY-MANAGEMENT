// Proxy for the breadbot public sales API.
// https://breadbot.duckdns.org/api/v1/public — exposes per-store / per-date
// sales split across pos / delivery / kiosk channels. The raw API key is a
// secret that must not ship in the web bundle, so the client invokes this
// function and we inject Authorization: Bearer on the server side.
//
// Input  (POST body): { storeName: string, date: 'YYYY-MM-DD' }
// Output (200): { rows: Array<{rawItemName, canonical, qtySold, revenue}>, freshness_by_channel, meta }
// Output (4xx/5xx): { error: string }
//
// Endpoint: /sales (NOT /sales/daily). Breadbot now exposes a richer payload
// with both raw_item_name (exactly what the POS recorded) and canonical
// (Breadbot's own consolidation across 159 aliases — e.g. BIRD & BURIED →
// Chicken Tender Basket). We pass BOTH fields through so the client can
// display the canonical as an informational hint while still feeding the raw
// POS string into our existing recipe-matcher pipeline (pos_recipe_aliases
// is keyed against raw POS strings — feeding canonical there would break
// every existing alias).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Our stores.name → breadbot /sales?store=<code>
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
  raw_item_name: string;
  // Back-compat copy from upstream (currently equals raw). Kept so we can
  // gracefully fall back if a partial deploy on Breadbot's side ever sends
  // `item_name` without `raw_item_name`.
  item_name: string;
  item_id?: number;
  // Breadbot's canonicalized name resolved via its own 159-alias table.
  // The live /sales endpoint emits this as `canonical_item_name`.
  canonical_item_name: string;
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

    // Call breadbot. /sales takes a date RANGE via start/end (inclusive). For
    // a single business day we set both to the same value; the upstream
    // returns the rows whose `date` field equals that day.
    const upstreamUrl = new URL(`${BREADBOT_BASE_URL}/sales`);
    upstreamUrl.searchParams.set('store', code);
    upstreamUrl.searchParams.set('start', date);
    upstreamUrl.searchParams.set('end', date);

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

    // Collapse channels: sum quantity per (raw_item_name, canonical). POS
    // import tables don't carry a channel column today; the CSV flow was
    // already channel-agnostic. We key on the pair (using a control-char
    // separator that can't appear in either name) so two raw POS strings that
    // resolve to the same canonical are still preserved as distinct rows in
    // our DB — preserves the audit trail of what the POS actually recorded.
    const totals = new Map<string, { rawItemName: string; canonical: string; qty: number }>();
    for (const r of upstreamRows) {
      // Prefer raw_item_name; fall back to item_name (BC) so a partial
      // upstream deploy doesn't crash the proxy.
      const raw = (r.raw_item_name || r.item_name || '').trim();
      if (!raw) continue;
      // Upstream emits canonical_item_name; fall back to raw if absent so
      // our rows are always meaningful.
      const canonical = (r.canonical_item_name || raw).trim();
      const qty = Number(r.quantity_sold) || 0;
      const key = `${raw}\u0001${canonical}`;
      const existing = totals.get(key);
      if (existing) {
        existing.qty += qty;
      } else {
        totals.set(key, { rawItemName: raw, canonical, qty });
      }
    }

    const rows = Array.from(totals.values())
      .filter((v) => v.qty > 0)
      .map((v) => ({
        rawItemName: v.rawItemName,
        canonical: v.canonical,
        qtySold: v.qty,
        revenue: 0,
      }))
      .sort((a, b) => b.qtySold - a.qtySold);

    return json(200, {
      rows,
      freshness_by_channel: payload?.meta?.freshness_by_channel ?? null,
      meta: {
        store_code: code,
        date,
        endpoint: 'sales',
        upstream_row_count: upstreamRows.length,
        collapsed_row_count: rows.length,
      },
    });
  } catch (e: any) {
    console.error('fetch-breadbot-sales crashed:', e?.message || e);
    return json(500, { error: 'Internal error' });
  }
});
