// PWA catalog ship-out — sibling of staff-catalog, but for the first-party
// PWA. Returns a complete, normalized catalog snapshot for one store:
//
//   GET /pwa-catalog?store_id={uuid}&since={iso8601?}
//   Authorization: Bearer ${PWA_SERVICE_TOKEN}
//
// Returns:
//   - ingredients              (inventory_items for this store)
//   - vendors
//   - ingredient_categories
//   - recipe_categories
//   - recipes                  (with normalized recipe_ingredients carrying
//                               base_quantity/base_unit AND recipe_prep_items)
//   - prep_recipes             (with prep_recipe_ingredients, including the
//                               type='raw'|'prep' + sub_recipe_id nesting)
//   - ingredient_conversions   (purchase_unit -> base_unit + net_yield_pct)
//
// Delta sync: only `inventory_items` carries `updated_at` in the current
// schema (recipes/prep/conversions don't), so the `since` param filters
// inventory_items only and the etag tracks max(inventory_items.updated_at)
// in the response. Recipes/prep/conversions/categories/vendors are always
// shipped in full — they're small per store and rarely change.
//
// Auth: Bearer PWA_SERVICE_TOKEN. Service-to-service trust; the PWA's own
// backend signs each call (same model as staff-catalog).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PWA_SERVICE_TOKEN = Deno.env.get("PWA_SERVICE_TOKEN") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

function checkAuth(req: Request): Response | null {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!PWA_SERVICE_TOKEN) {
    return jsonResponse(500, { error: "PWA_SERVICE_TOKEN unset on server" });
  }
  if (token !== PWA_SERVICE_TOKEN) {
    return jsonResponse(401, { error: "invalid service token" });
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return jsonResponse(405, { error: "method not allowed" });
  }

  const authFail = checkAuth(req);
  if (authFail) return authFail;

  const url = new URL(req.url);
  const storeId = url.searchParams.get("store_id");
  const since = url.searchParams.get("since"); // ISO8601 — optional, applies to inventory_items only

  if (!storeId) {
    return jsonResponse(400, { error: "store_id query param required" });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve store
  const { data: store, error: storeErr } = await admin
    .from("stores")
    .select("id, name")
    .eq("id", storeId)
    .maybeSingle();
  if (storeErr) {
    return jsonResponse(500, { error: "stores lookup failed", detail: storeErr.message });
  }
  if (!store) {
    return jsonResponse(404, { error: "store not found" });
  }

  // ── Build queries ──────────────────────────────────────────
  let ingQuery = admin
    .from("inventory_items")
    .select(
      "id, store_id, name, category, unit, par_level, current_stock, cost_per_unit, vendor_id, case_qty, case_price, sub_unit_size, sub_unit_unit, average_daily_usage, safety_stock, updated_at",
    )
    .eq("store_id", storeId);
  if (since) ingQuery = ingQuery.gt("updated_at", since);

  // recipes + embedded recipe_ingredients (with base_quantity/base_unit) and recipe_prep_items
  const recipesQuery = admin
    .from("recipes")
    .select(
      "id, store_id, menu_item, category, sell_price, " +
        "recipe_ingredients(item_id, quantity, unit, base_quantity, base_unit), " +
        "recipe_prep_items(prep_recipe_id, quantity, unit)",
    )
    .eq("store_id", storeId);

  // prep_recipes + embedded prep_recipe_ingredients (raw/prep nesting)
  const prepRecipesQuery = admin
    .from("prep_recipes")
    .select(
      "id, store_id, name, category, yield_quantity, yield_unit, version, is_current, parent_id, notes, " +
        "prep_recipe_ingredients!prep_recipe_id(item_id, sub_recipe_id, type, quantity, unit, base_quantity, base_unit)",
    )
    .eq("store_id", storeId);

  // ingredient_conversions for items in this store. Filter via inner-joined
  // inventory_items.store_id; then strip the join column from the response.
  const conversionsQuery = admin
    .from("ingredient_conversions")
    .select(
      "id, inventory_item_id, purchase_unit, base_unit, conversion_factor, net_yield_pct, inventory_items!inner(store_id)",
    )
    .eq("inventory_items.store_id", storeId);

  const vendorsQuery = admin
    .from("vendors")
    .select("id, name, lead_time_days, order_cutoff_time, delivery_days")
    .order("name");

  const ingCategoriesQuery = admin.from("ingredient_categories").select("name").order("name");
  const recCategoriesQuery = admin.from("recipe_categories").select("name").order("name");

  const [ingRes, recRes, prepRes, convRes, venRes, ingCatRes, recCatRes] = await Promise.all([
    ingQuery.order("name"),
    recipesQuery,
    prepRecipesQuery,
    conversionsQuery,
    vendorsQuery,
    ingCategoriesQuery,
    recCategoriesQuery,
  ]);

  const firstErr =
    ingRes.error || recRes.error || prepRes.error || convRes.error || venRes.error || ingCatRes.error || recCatRes.error;
  if (firstErr) {
    return jsonResponse(500, { error: "catalog fetch failed", detail: firstErr.message });
  }

  // ── Etag = max(inventory_items.updated_at) in this response ─
  let etag: string | null = null;
  for (const row of ingRes.data || []) {
    const ts = row.updated_at as string | null;
    if (ts && (!etag || ts > etag)) etag = ts;
  }

  // ── Shape the payload ──────────────────────────────────────
  const body = {
    etag,
    store: { id: store.id, name: store.name },
    ingredients: (ingRes.data || []).map((r: any) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      unit: r.unit,
      par_level: r.par_level,
      current_stock: r.current_stock,
      cost_per_unit: r.cost_per_unit,
      vendor_id: r.vendor_id,
      case_qty: r.case_qty,
      case_price: r.case_price,
      sub_unit_size: r.sub_unit_size,
      sub_unit_unit: r.sub_unit_unit,
      average_daily_usage: r.average_daily_usage,
      safety_stock: r.safety_stock,
      updated_at: r.updated_at,
    })),
    vendors: (venRes.data || []).map((v: any) => ({
      id: v.id,
      name: v.name,
      lead_time_days: v.lead_time_days,
      order_cutoff_time: v.order_cutoff_time,
      delivery_days: v.delivery_days,
    })),
    ingredient_categories: (ingCatRes.data || []).map((c: any) => c.name),
    recipe_categories: (recCatRes.data || []).map((c: any) => c.name),
    ingredient_conversions: (convRes.data || []).map((c: any) => ({
      id: c.id,
      inventory_item_id: c.inventory_item_id,
      purchase_unit: c.purchase_unit,
      base_unit: c.base_unit,
      conversion_factor: c.conversion_factor,
      net_yield_pct: c.net_yield_pct,
    })),
    recipes: (recRes.data || []).map((r: any) => ({
      id: r.id,
      menu_item: r.menu_item,
      category: r.category,
      sell_price: r.sell_price,
      ingredients: (r.recipe_ingredients || []).map((ing: any) => ({
        item_id: ing.item_id,
        quantity: ing.quantity,
        unit: ing.unit,
        base_quantity: ing.base_quantity,
        base_unit: ing.base_unit,
      })),
      prep_items: (r.recipe_prep_items || []).map((p: any) => ({
        prep_recipe_id: p.prep_recipe_id,
        quantity: p.quantity,
        unit: p.unit,
      })),
    })),
    prep_recipes: (prepRes.data || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      yield_quantity: p.yield_quantity,
      yield_unit: p.yield_unit,
      version: p.version,
      is_current: p.is_current,
      parent_id: p.parent_id,
      notes: p.notes,
      ingredients: (p.prep_recipe_ingredients || []).map((ing: any) => ({
        type: ing.type,
        item_id: ing.item_id,
        sub_recipe_id: ing.sub_recipe_id,
        quantity: ing.quantity,
        unit: ing.unit,
        base_quantity: ing.base_quantity,
        base_unit: ing.base_unit,
      })),
    })),
    is_delta: !!since,
  };

  return jsonResponse(200, body, {
    ...(etag ? { ETag: `"${etag}"` } : {}),
    "Cache-Control": "private, max-age=60",
  });
});
