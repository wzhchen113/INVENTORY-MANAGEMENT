// Nightly breadbot sync — pulls yesterday's per-store POS data from the
// breadbot public API and imports it the same way the in-app button does,
// without a human in the loop. Scheduled via pg_cron at 10:00 UTC daily
// (= 06:00 EDT / 05:00 EST — 2h after breadbot's 04:00 local business-day
// rollover).
//
// Auth: no JWT (verify_jwt=false — pg_cron has no user session), protected
// by an x-cron-secret header matched against BREADBOT_CRON_SECRET. The
// scheduled pg_cron row embeds the matching secret as a literal;
// cron.job is only readable by DB-privileged roles so it's no worse
// than service_role already being in that trust boundary.
//
// Idempotency: if pos_imports already has a row for (store, yesterday) —
// whether from a manual in-app import or a previous cron fire — the store
// is skipped. This matches the backfill's dedup path so running the cron
// after a manual import is safe (no double-deduction).
//
// Scope: only stores in STORE_MAP are synced. The rest are untouched. This
// file's STORE_MAP MUST stay in sync with fetch-breadbot-sales/index.ts.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Match fetch-breadbot-sales/index.ts. Keep in sync by hand until we have
// a 4th store and move it to a table.
const STORE_MAP: Record<string, string> = {
  Frederick: 'frederick',
  Charles: 'charles',
  Towson: 'york', // breadbot's "york" is our internal "Towson".
};

const DEFAULT_BASE_URL = 'https://breadbot.duckdns.org/api/v1/public';
const DEFAULT_TIMEZONE = 'America/New_York';

// ─── Unit conversion (ported from src/utils/unitConversion.ts) ─────────
// Weight → grams (base unit: 'g')
const WEIGHT_TO_GRAMS: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lbs: 453.592,
};
// Volume → fluid ounces (base unit: 'fl_oz')
const VOLUME_TO_FLOZ: Record<string, number> = {
  fl_oz: 1,
  cups: 8,
  qt: 32,
  gal: 128,
};

function getConversionFactor(fromUnit: string, toUnit: string): number | null {
  if (fromUnit === toUnit) return 1;
  const from = fromUnit.toLowerCase();
  const to = toUnit.toLowerCase();
  if (WEIGHT_TO_GRAMS[from] !== undefined && WEIGHT_TO_GRAMS[to] !== undefined) {
    return WEIGHT_TO_GRAMS[from] / WEIGHT_TO_GRAMS[to];
  }
  if (VOLUME_TO_FLOZ[from] !== undefined && VOLUME_TO_FLOZ[to] !== undefined) {
    return VOLUME_TO_FLOZ[from] / VOLUME_TO_FLOZ[to];
  }
  return null;
}

// ─── Recipe matcher (mirrors src/utils/recipeMatch.ts) ─────────────────
// Waterfall: alias → exact → token-set → containment → none. Keep in sync
// with the client copy by hand (Deno can't reach into src/).
type RecipeRow = { id: string; store_id: string; menu_item: string };
type AliasRow = { pos_name: string; recipe_id: string };

const STOP_TOKENS = new Set(['and']);
const COUNT_TOKEN_RE = /^\d+(pc|pcs|ct|cts)?$/;
const SKIP_RE = /^(no |add utensils|extra |add )/;

function significantTokens(s: string): string[] {
  const raw = s.toLowerCase().split(/[\s\-_\/(),.&]+/).filter(Boolean);
  let i = 0;
  while (i < raw.length && COUNT_TOKEN_RE.test(raw[i])) i++;
  return raw.slice(i)
    .map((t) => (t.length >= 4 && t.endsWith('s') ? t.slice(0, -1) : t))
    .filter((t) => t && !STOP_TOKENS.has(t));
}

function tokensSubsetOf(a: string[], b: string[]): boolean {
  if (a.length === 0) return false;
  const set = new Set(b);
  return a.every((t) => set.has(t));
}

function findRecipe(menuItem: string, recipes: RecipeRow[], aliases: AliasRow[]): RecipeRow | undefined {
  const lower = menuItem.toLowerCase().trim();
  if (!lower || SKIP_RE.test(lower)) return undefined;

  // 1. Alias — case-insensitive on pos_name.
  const alias = aliases.find((a) => a.pos_name.toLowerCase().trim() === lower);
  if (alias) {
    const r = recipes.find((rec) => rec.id === alias.recipe_id);
    if (r) return r;
    // alias points to a deleted recipe — fall through
  }

  // 2. Exact case-insensitive
  const exact = recipes.find((r) => r.menu_item.toLowerCase() === lower);
  if (exact) return exact;

  // 3. Token-set, ranked by recipe specificity.
  const posTokens = significantTokens(menuItem);
  if (posTokens.length > 0) {
    const ranked = recipes
      .map((r) => ({ recipe: r, rTokens: significantTokens(r.menu_item) }))
      .filter(({ rTokens }) => tokensSubsetOf(rTokens, posTokens))
      .sort((a, b) => b.rTokens.length - a.rTokens.length);
    if (ranked[0]) return ranked[0].recipe;
  }

  // 4. Containment fallback.
  return recipes.find((r) => {
    const rLower = r.menu_item.toLowerCase();
    if (lower.length < 4 || rLower.length < 4) return false;
    return lower.includes(rLower) || rLower.includes(lower);
  });
}

// ─── Date helpers ──────────────────────────────────────────────────────
// "Yesterday's business date" in the target timezone. At 10 UTC on
// 2026-04-24, EDT local is 06:00 on 2026-04-24, so "yesterday" is
// 2026-04-23. Subtract 24h from real now, then format in tz — handles DST
// boundaries because Intl does the math.
function yesterdayInTZ(tz: string): string {
  const shifted = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(shifted).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// ─── Upstream fetch (matches fetch-breadbot-sales) ─────────────────────
type BreadbotSaleRow = {
  date: string;
  store_id: string;
  raw_item_name: string;
  // BC fallback — Breadbot still emits this, currently == raw.
  item_name: string;
  item_id?: number;
  // Breadbot's own canonical (resolved via 159 aliases). Upstream field
  // name on the live /sales endpoint is `canonical_item_name`.
  canonical_item_name: string;
  channel: string;
  quantity_sold: number;
};
// Both raw and canonical surface here. Recipe matching feeds rawItemName
// into findRecipe (pos_recipe_aliases is keyed on raw POS strings). DB
// writes also store rawItemName as menu_item to preserve the audit trail.
// Canonical is captured for future use but not persisted in this PR (no
// schema change).
type CollapsedRow = {
  rawItemName: string;
  canonical: string;
  qtySold: number;
  revenue: number;
};

async function fetchBreadbotDay(
  baseUrl: string,
  apiKey: string,
  storeCode: string,
  date: string,
): Promise<CollapsedRow[]> {
  // /sales takes start/end (inclusive). For one business day, set both
  // to the same value.
  const url = new URL(`${baseUrl}/sales`);
  url.searchParams.set('store', storeCode);
  url.searchParams.set('start', date);
  url.searchParams.set('end', date);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Breadbot ${r.status}: ${text.slice(0, 200)}`);
  }
  let payload: any;
  try { payload = JSON.parse(text); }
  catch { throw new Error('Breadbot returned non-JSON'); }
  const rows: BreadbotSaleRow[] = Array.isArray(payload?.data) ? payload.data : [];
  // Collapse by (raw_item_name, canonical). Control-char separator avoids
  // collisions with names containing pipe/colon/etc.
  const totals = new Map<string, { rawItemName: string; canonical: string; qty: number }>();
  for (const row of rows) {
    const raw = (row.raw_item_name || row.item_name || '').trim();
    if (!raw) continue;
    // Upstream emits canonical_item_name; raw fallback keeps rows meaningful.
    const canonical = (row.canonical_item_name || raw).trim();
    const qty = Number(row.quantity_sold) || 0;
    const key = `${raw}\u0001${canonical}`;
    const existing = totals.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      totals.set(key, { rawItemName: raw, canonical, qty });
    }
  }
  return Array.from(totals.values())
    .filter((v) => v.qty > 0)
    .map((v) => ({
      rawItemName: v.rawItemName,
      canonical: v.canonical,
      qtySold: v.qty,
      revenue: 0,
    }))
    .sort((a, b) => b.qtySold - a.qtySold);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Per-store worker ──────────────────────────────────────────────────
type StoreOutcome =
  | { store: string; outcome: 'imported'; itemCount: number; mappedCount: number; unmappedCount: number; upstreamRows: number }
  | { store: string; outcome: 'skipped'; reason: string }
  | { store: string; outcome: 'failed'; error: string };

async function syncStore(
  sb: any,
  storeName: string,
  storeCode: string,
  date: string,
  breadbotBaseUrl: string,
  breadbotApiKey: string,
): Promise<StoreOutcome> {
  // Resolve store_id by name.
  const { data: storeRow, error: storeErr } = await sb
    .from('stores').select('id').eq('name', storeName).maybeSingle();
  if (storeErr) throw new Error(`stores lookup: ${storeErr.message}`);
  if (!storeRow?.id) {
    return { store: storeName, outcome: 'skipped', reason: 'store_not_found' };
  }
  const storeId = storeRow.id as string;

  // Dedup: already imported for this date?
  const { count: existingCount, error: countErr } = await sb
    .from('pos_imports').select('id', { count: 'exact', head: true })
    .eq('store_id', storeId).eq('import_date', date);
  if (countErr) throw new Error(`dedup check: ${countErr.message}`);
  if ((existingCount ?? 0) > 0) {
    return { store: storeName, outcome: 'skipped', reason: 'already_imported' };
  }

  // Fetch upstream.
  const upstream = await fetchBreadbotDay(breadbotBaseUrl, breadbotApiKey, storeCode, date);
  if (upstream.length === 0) {
    return { store: storeName, outcome: 'skipped', reason: 'no_upstream_data' };
  }

  // Load recipes + ingredients + inventory + aliases for this store.
  const { data: recipes, error: recErr } = await sb
    .from('recipes').select('id, store_id, menu_item').eq('store_id', storeId);
  if (recErr) throw new Error(`recipes: ${recErr.message}`);
  const recipeRows = (recipes || []) as RecipeRow[];

  const { data: aliasRows } = await sb
    .from('pos_recipe_aliases').select('pos_name, recipe_id')
    .or(`store_id.eq.${storeId},store_id.is.null`);
  const aliases = (aliasRows || []) as AliasRow[];

  const recipeIds = recipeRows.map((r) => r.id);
  const { data: ingRows, error: ingErr } = recipeIds.length > 0
    ? await sb.from('recipe_ingredients')
        .select('id, recipe_id, item_id, quantity, unit').in('recipe_id', recipeIds)
    : { data: [], error: null };
  if (ingErr) throw new Error(`recipe_ingredients: ${ingErr.message}`);
  const ingByRecipe = new Map<string, Array<{ item_id: string; quantity: number; unit: string }>>();
  for (const row of (ingRows || []) as any[]) {
    if (!ingByRecipe.has(row.recipe_id)) ingByRecipe.set(row.recipe_id, []);
    ingByRecipe.get(row.recipe_id)!.push({
      item_id: row.item_id,
      quantity: Number(row.quantity) || 0,
      unit: String(row.unit || ''),
    });
  }

  const { data: invRows, error: invErr } = await sb
    .from('inventory_items').select('id, current_stock, unit').eq('store_id', storeId);
  if (invErr) throw new Error(`inventory_items: ${invErr.message}`);
  const inventoryById = new Map<string, { current_stock: number; unit: string }>();
  for (const row of (invRows || []) as any[]) {
    inventoryById.set(row.id, {
      current_stock: Number(row.current_stock) || 0,
      unit: String(row.unit || ''),
    });
  }

  // Insert pos_imports (one per store/day). imported_by=null distinguishes
  // cron writes from human ones in the audit trail.
  const { data: importRow, error: insErr } = await sb
    .from('pos_imports').insert({
      store_id: storeId,
      filename: `Breadbot nightly · ${storeName} · ${date}`,
      imported_by: null,
      import_date: date,
    }).select().single();
  if (insErr) throw new Error(`pos_imports insert: ${insErr.message}`);
  const importId = importRow.id as string;

  // Build pos_import_items with recipe matches (alias → exact → fuzzy).
  // Feed rawItemName into findRecipe — pos_recipe_aliases is keyed against
  // raw POS strings, so matching on canonical here would silently break
  // every existing alias. menu_item is also the raw string to preserve the
  // audit trail of what the POS actually recorded.
  const items = upstream.map((row) => {
    const recipe = findRecipe(row.rawItemName, recipeRows, aliases);
    return {
      import_id: importId,
      menu_item: row.rawItemName,
      qty_sold: row.qtySold,
      revenue: row.revenue,
      recipe_id: recipe?.id ?? null,
      recipe_mapped: Boolean(recipe),
    };
  });
  const { error: itemsErr } = await sb.from('pos_import_items').insert(items);
  if (itemsErr) throw new Error(`pos_import_items insert: ${itemsErr.message}`);
  const unmappedCount = items.filter((i) => !i.recipe_mapped).length;

  // Deduct inventory — serial writes so subsequent sales in this run read
  // post-decrement stock. Matches useStore.ts:610-645 (with conversion)
  // rather than useSupabaseStore.ts (without) — per plan approval.
  let mappedCount = 0;
  for (const item of items) {
    if (!item.recipe_mapped || !item.recipe_id) continue;
    mappedCount++;
    const ings = ingByRecipe.get(item.recipe_id) || [];
    for (const ing of ings) {
      const inv = inventoryById.get(ing.item_id);
      if (!inv) continue;
      const factor = getConversionFactor(ing.unit, inv.unit);
      const convertedQty = factor !== null ? ing.quantity * factor : ing.quantity;
      const newStock = Math.max(0, inv.current_stock - convertedQty * item.qty_sold);
      const { error: updErr } = await sb
        .from('inventory_items')
        .update({ current_stock: newStock, last_updated_by: null })
        .eq('id', ing.item_id);
      if (updErr) {
        // Single-item update failure doesn't abort the store — log and
        // continue. Reconciliation will surface the drift.
        console.error(`[${storeName}] stock update failed for item ${ing.item_id}:`, updErr.message);
        continue;
      }
      inv.current_stock = newStock;
    }
  }

  return {
    store: storeName,
    outcome: 'imported',
    itemCount: items.length,
    mappedCount,
    unmappedCount,
    upstreamRows: upstream.length,
  };
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    // Shared-secret auth. pg_cron passes x-cron-secret; reject everything
    // else. Secret comparison is timing-safe-ish (identical length strings
    // from openssl rand + constant-time compare isn't trivial in Deno stdlib
    // without pulling a crate; the attack surface here is noise, not timing).
    const providedSecret = req.headers.get('x-cron-secret') ?? '';
    const expectedSecret = Deno.env.get('BREADBOT_CRON_SECRET') ?? '';
    if (!expectedSecret) {
      console.error('BREADBOT_CRON_SECRET not set on function');
      return json(500, { error: 'Server not configured' });
    }
    if (providedSecret !== expectedSecret) {
      return json(401, { error: 'Unauthorized' });
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const BREADBOT_API_KEY = Deno.env.get('BREADBOT_API_KEY');
    const BREADBOT_BASE_URL = Deno.env.get('BREADBOT_BASE_URL') ?? DEFAULT_BASE_URL;
    const TZ = Deno.env.get('DEFAULT_TIMEZONE') ?? DEFAULT_TIMEZONE;

    const missing: string[] = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!BREADBOT_API_KEY) missing.push('BREADBOT_API_KEY');
    if (missing.length > 0) {
      return json(500, { error: `Missing env: ${missing.join(', ')}` });
    }

    // Allow manual invocation with a specific date override via body.date,
    // useful for one-off catch-up runs. Default is yesterday in tz.
    let bodyDate: string | null = null;
    try {
      const parsed = await req.json().catch(() => ({}));
      if (typeof parsed?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
        bodyDate = parsed.date;
      }
    } catch { /* body optional */ }
    const targetDate = bodyDate ?? yesterdayInTZ(TZ);

    const sb = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const results: StoreOutcome[] = [];
    for (const [storeName, storeCode] of Object.entries(STORE_MAP)) {
      try {
        const outcome = await syncStore(
          sb, storeName, storeCode, targetDate, BREADBOT_BASE_URL, BREADBOT_API_KEY!,
        );
        results.push(outcome);
        console.log(`[${storeName}]`, JSON.stringify(outcome));
      } catch (e: any) {
        const failure: StoreOutcome = {
          store: storeName,
          outcome: 'failed',
          error: e?.message || String(e),
        };
        results.push(failure);
        console.error(`[${storeName}] failed:`, failure.error);
      }
    }

    return json(200, { date: targetDate, results });
  } catch (e: any) {
    console.error('breadbot-nightly-sync crashed:', e?.message || e);
    return json(500, { error: 'Internal error', detail: e?.message || String(e) });
  }
});
