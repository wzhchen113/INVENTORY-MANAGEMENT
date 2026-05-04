// PWA catalog ship-out — sibling of staff-catalog, but for the first-party
// PWA. Returns a complete, normalized catalog snapshot for one store:
//
//   GET /pwa-catalog?store_id={uuid}&since={iso8601?}
//   Authorization: Bearer ${PWA_SERVICE_TOKEN}
//
// Returns:
//   - ingredients              (per-store inventory_items rows joined to
//                               their brand-level catalog_ingredients row
//                               for name/unit/category/case packing)
//   - vendors                  (brand-scoped)
//   - ingredient_categories
//   - recipe_categories
//   - recipes                  (BRAND-level — every store sees the same set;
//                               recipe_ingredients carry catalog_id rather
//                               than the legacy per-store item_id)
//   - prep_recipes             (BRAND-level; prep_recipe_ingredients carry
//                               catalog_id for raw rows or sub_recipe_id
//                               for nested-prep rows)
//   - ingredient_conversions   (BRAND-level, keyed by catalog_id)
//
// Delta sync: only `inventory_items` carries `updated_at` in the current
// schema (recipes/prep/conversions don't), so the `since` param filters
// inventory_items only and the etag tracks max(inventory_items.updated_at)
// in the response. Recipes/prep/conversions/categories/vendors are always
// shipped in full — they're small per brand and rarely change.
//
// ⚠️ API CHANGE (post-brand-catalog-refactor): consumers that previously
// joined recipes by `recipe.ingredients[].item_id === inventory.id` must
// switch to `recipe.ingredients[].catalog_id === inventory.catalog_id`.
// Each ingredient row exposes `catalog_id` so the join key is brand-stable.
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

  // Resolve store + its brand. Brand-level data (recipes, preps, vendors,
  // conversions) is keyed by brand_id; per-store data (inventory_items)
  // by store_id.
  const { data: store, error: storeErr } = await admin
    .from("stores")
    .select("id, name, brand_id")
    .eq("id", storeId)
    .maybeSingle();
  if (storeErr) {
    return jsonResponse(500, { error: "stores lookup failed", detail: storeErr.message });
  }
  if (!store) {
    return jsonResponse(404, { error: "store not found" });
  }
  const brandId = store.brand_id as string | null;
  if (!brandId) {
    return jsonResponse(500, { error: "store has no brand_id — run brand catalog migrations" });
  }

  // ── Build queries ──────────────────────────────────────────
  // inventory_items now holds only per-store state. name/unit/category and
  // case packing live on catalog_ingredients (brand-level), JOINed in.
  let ingQuery = admin
    .from("inventory_items")
    .select(
      "id, store_id, catalog_id, vendor_id, par_level, current_stock, cost_per_unit, case_price, average_daily_usage, safety_stock, updated_at, " +
        "catalog:catalog_ingredients(name, unit, category, case_qty, sub_unit_size, sub_unit_unit)",
    )
    .eq("store_id", storeId);
  if (since) ingQuery = ingQuery.gt("updated_at", since);

  // Recipes are brand-scoped after the catalog refactor. recipe_ingredients
  // carry catalog_id (the brand-level ingredient identity) instead of the
  // legacy per-store item_id.
  const recipesQuery = admin
    .from("recipes")
    .select(
      "id, brand_id, menu_item, category, sell_price, " +
        "recipe_ingredients(catalog_id, quantity, unit, base_quantity, base_unit), " +
        "recipe_prep_items(prep_recipe_id, quantity, unit)",
    )
    .eq("brand_id", brandId);

  // Prep recipes are brand-scoped. Raw-ingredient rows carry catalog_id;
  // sub-recipe rows carry sub_recipe_id (mutually exclusive, enforced by
  // CHECK constraint).
  const prepRecipesQuery = admin
    .from("prep_recipes")
    .select(
      "id, brand_id, name, category, yield_quantity, yield_unit, version, is_current, parent_id, notes, " +
        "prep_recipe_ingredients!prep_recipe_id(catalog_id, sub_recipe_id, type, quantity, unit, base_quantity, base_unit)",
    )
    .eq("brand_id", brandId);

  // Conversions are brand-level (one row per catalog ingredient + purchase
  // unit). Filter through the catalog_ingredients FK to scope to this brand.
  const conversionsQuery = admin
    .from("ingredient_conversions")
    .select(
      "id, catalog_id, purchase_unit, base_unit, conversion_factor, net_yield_pct, catalog_ingredients!inner(brand_id)",
    )
    .eq("catalog_ingredients.brand_id", brandId);

  const vendorsQuery = admin
    .from("vendors")
    .select("id, name, lead_time_days, order_cutoff_time, delivery_days")
    .eq("brand_id", brandId)
    .order("name");

  const ingCategoriesQuery = admin.from("ingredient_categories").select("name").order("name");
  const recCategoriesQuery = admin.from("recipe_categories").select("name").order("name");

  // Can't ORDER BY name on inventory_items anymore — name lives on the
  // joined catalog row and PostgREST won't sort by an embedded column.
  // Consumer sorts client-side.
  const [ingRes, recRes, prepRes, convRes, venRes, ingCatRes, recCatRes] = await Promise.all([
    ingQuery,
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
  // PostgREST returns embedded relations as a single object for to-one
  // FKs (catalog_ingredients here is to-one), but supabase-js sometimes
  // types it as an array. Normalize either shape via .catalog ?? [first].
  const catalogOf = (row: any) => (Array.isArray(row.catalog) ? row.catalog[0] : row.catalog) || {};
  const body = {
    etag,
    store: { id: store.id, name: store.name, brand_id: brandId },
    ingredients: (ingRes.data || []).map((r: any) => {
      const cat = catalogOf(r);
      return {
        id: r.id,                    // per-store inventory_items.id
        catalog_id: r.catalog_id,    // brand-stable join key for recipes
        name: cat.name,
        category: cat.category,
        unit: cat.unit,
        par_level: r.par_level,
        current_stock: r.current_stock,
        cost_per_unit: r.cost_per_unit,
        vendor_id: r.vendor_id,
        case_qty: cat.case_qty,
        case_price: r.case_price,
        sub_unit_size: cat.sub_unit_size,
        sub_unit_unit: cat.sub_unit_unit,
        average_daily_usage: r.average_daily_usage,
        safety_stock: r.safety_stock,
        updated_at: r.updated_at,
      };
    }),
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
      catalog_id: c.catalog_id,
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
        catalog_id: ing.catalog_id,
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
        catalog_id: ing.catalog_id,
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
