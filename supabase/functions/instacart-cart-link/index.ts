// Spec 149 (§5) — instacart-cart-link.
//
// Mints an Instacart Developer Platform (IDP) shopping-list link from an
// ALREADY-PERSISTED public.order_approvals row. This is the ONLY place the IDP
// API key lives (AC-22): a Supabase function secret, read via Deno.env.get,
// never returned in a response and never logged. A client-side fetch to
// connect.instacart.com anywhere under src/ is a Critical.
//
// POSTURE — the OPPOSITE of the staff-* / cron functions: this is an
// admin-triggered action carrying the CALLER's Supabase JWT.
// config.toml pins verify_jwt = true explicitly (see the entry there), and the
// inline requireAdminCaller() / ADMIN_ROLES gate mirrors
// public.auth_is_privileged() per the CLAUDE.md edge-function role-gate
// convention (reference shape: supabase/functions/delete-user/index.ts:19).
// Inline, NOT `_shared/` — CLAUDE.md spec-027 §4.2 rationale (the supabase CLI
// deploys one function at a time, so shared modules are invisible drift surface).
//
// AC-24 STORE SCOPE WITHOUT TRUSTING THE BODY: the request carries only
// { approvalId }. Every read on the request path goes through an anon-key client
// carrying the CALLER's bearer, so RLS clips it — a cross-store approvalId
// returns zero rows ⇒ 404, before any upstream contact. There is NO service-role
// read on the request path. That keeps this function's blast radius to "holds a
// secret, calls one upstream" (design guidance 3).
//
// AC-26 escapeHtml() DOES NOT APPLY — JSON-only responses, no HTML body, no
// email. Called out explicitly so review does not flag its absence as drift.
// Self-guard / last-of-role guard: N/A — no role change, no deletion.
//
// ─────────────────────────────────────────────────────────────────────────────
// IDP CONTRACT RECONCILIATION (spec 149 R-7 / OQ-5 — every §5.4/§5.5 field was
// marked MUST-VERIFY). Verified against the live docs on 2026-08-01:
//   https://docs.instacart.com/developer_platform_api/api/products/create_shopping_list_page
//   https://docs.instacart.com/developer_platform_api/api/retailers/get_nearby_retailers
//   https://docs.instacart.com/developer_platform_api/api/units_of_measurement
//   https://docs.instacart.com/developer_platform_api/api/changelog
// (all "Last updated on May 14, 2026")
//
//   CONFIRMED unchanged from the design:
//     • POST {base}/idp/v1/products/products_link
//     • Authorization: Bearer <key>, Content-Type + Accept: application/json
//     • body: title, link_type ('shopping_list'|'recipe'), expires_in (days,
//       max 365), instructions[], line_items[], landing_page_configuration
//     • line item: name, display_text
//     • response: { products_link_url }
//     • GET {base}/idp/v1/retailers?postal_code=&country_code= ⇒
//       { retailers: [{ retailer_key, name, retailer_logo_url }] }
//     • 'each' is a valid unit (Countable Items table)
//
//   DRIFT #1 (field relocation — handled here):
//     line_items[].quantity and line_items[].unit are DEPRECATED as of the
//     2026-03-18 changelog entry. The current shape is
//     line_items[].line_item_measurements: [{ quantity, unit }]. This function
//     sends line_item_measurements and does NOT send the deprecated fields.
//
//   DRIFT #2 (field is recipe-only — handled here):
//     landing_page_configuration.enable_pantry_items is documented as
//     "Default is false and only supported on 'recipe' link_type". The design's
//     §5.4 body set it true on a 'shopping_list'. It is OMITTED here.
//     landing_page_configuration is sent only when INSTACART_PARTNER_LINKBACK_URL
//     is configured; otherwise the whole object is omitted.
//
//   DRIFT #3 — *** ESCALATED TO THE PM, NOT WORKED AROUND ***:
//     THERE IS NO RETAILER-PINNING FIELD on products_link (or on the recipe
//     endpoint) in the current API. No retailer_key / retailer_id / preferred-
//     retailer parameter exists in either request body, and the Shopping list
//     page concept doc states plainly: "On the shopping list page, the user
//     selects their preferred store". The changelog's only preferred-retailer
//     entry (2025-04-17, recipe pages) is no longer reflected in the reference.
//     ⇒ The minted link opens a pre-filled shopping list on which the ADMIN
//       PICKS THE RETAILER. Spec 149 §5.4 says to STOP and surface this rather
//       than ship a link that lands on a retailer picker — it is surfaced in the
//       handoff as an open PM decision.
//     ⇒ Shipping posture is SAFE MEANWHILE, per the design's own §10.2
//       recommendation: leave vendors.order_channel NULL on BJ's and Sam's, so
//       R-3 resolves them to 'extension' and behavior is IDENTICAL to today.
//       Nothing reaches this function until an operator explicitly opts a vendor
//       in. vendors.instacart_retailer_key still does real work — it is the key
//       the §5.5 availability probe requires to resolve for the store's ZIP
//       before the channel is offered at all.
// ─────────────────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// AC-22 — the ONLY home of the IDP key. Never echoed, never logged.
const INSTACART_IDP_API_KEY = Deno.env.get("INSTACART_IDP_API_KEY") ?? "";
// Prod default. The docs publish a development host
// (https://connect.dev.instacart.tools) for pre-production keys; the override
// exists so scripts/smoke-instacart-cart-link.sh (AC-30) can point at the dev
// server or a local stub instead of production.
const INSTACART_IDP_BASE_URL =
  (Deno.env.get("INSTACART_IDP_BASE_URL") ?? "https://connect.instacart.com").replace(/\/+$/, "");
// Optional. When unset, landing_page_configuration is omitted entirely rather
// than sent with a placeholder.
const INSTACART_PARTNER_LINKBACK_URL = Deno.env.get("INSTACART_PARTNER_LINKBACK_URL") ?? "";

// Design guidance 7 — a hung upstream must not pin the function.
const UPSTREAM_TIMEOUT_MS = 10_000;
// AC-27 bounds (§5.4 "Validation before the upstream call").
const MAX_LINE_ITEMS = 100;
const MAX_QUANTITY = 9999;
const MAX_NAME_LEN = 200;
// §5.4 body: days until the link expires. Drives external_ref_expires_at.
const LINK_EXPIRES_IN_DAYS = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrderChannel = "instacart" | "webstaurant" | "extension" | "manual";

type ApprovalLine = {
  item_id?: unknown;
  item_name?: unknown;
  qty_base?: unknown;
  case_qty?: unknown;
  unit?: unknown;
  cost_per_counted_unit?: unknown;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── AC-23 role gate ────────────────────────────────────────────────────────
// Mirrors public.auth_is_privileged() (admin OR super-admin). Copied in shape
// from supabase/functions/delete-user/index.ts:19-47, including the
// profiles.role fallback for callers whose JWT hasn't refreshed since a role
// change. A non-privileged caller gets 401/403 with NO upstream call made.
const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);

// The gate also hands back the caller-token client so the request path never
// needs a second construction (and never needs service_role) — AC-24.
type AdminGate =
  | { status: 200; userId: string; appRole: string; client: SupabaseClient }
  | { status: 401 | 403; error: string };

async function requireAdminCaller(authHeader: string | null): Promise<AdminGate> {
  if (!authHeader?.startsWith("Bearer ")) return { error: "missing bearer token", status: 401 };
  const token = authHeader.slice(7);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userRes, error: userErr } = await client.auth.getUser();
  if (userErr || !userRes?.user) return { error: "invalid token", status: 401 };
  const appRole = (userRes.user.app_metadata as Record<string, unknown> | null)?.role as
    | string
    | undefined;
  if (appRole && ADMIN_ROLES.has(appRole)) {
    return { userId: userRes.user.id, appRole, status: 200, client };
  }
  const { data: profile } = await client
    .from("profiles")
    .select("role")
    .eq("id", userRes.user.id)
    .single();
  if (!profile || !ADMIN_ROLES.has(profile.role)) return { error: "forbidden", status: 403 };
  return { userId: userRes.user.id, appRole: profile.role, status: 200, client };
}

// ─── upstream helper ────────────────────────────────────────────────────────
class UpstreamTimeout extends Error {}

async function idpFetch(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new UpstreamTimeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// §5.4 quantity mapping. Approval lines are BASE / COUNTED units; a case row
// (case_qty > 1) is ordered in whole cases. This is a DELIBERATE two-line mirror
// of src/utils/poCaseDisplay.ts `isCaseRow` + a ceil-to-cases — the edge function
// is a separate Deno bundle and cannot import from src/.
function isCaseRow(caseQty: number): boolean {
  return Number.isFinite(caseQty) && caseQty > 1;
}

type IdpLineItem = {
  name: string;
  display_text: string;
  line_item_measurements: Array<{ quantity: number; unit: string }>;
};

// AC-27 — validate BEFORE any upstream call. Returns either the mapped line
// items or a stable `invalid lines: <reason>` string.
function buildLineItems(
  lines: unknown,
): { ok: true; items: IdpLineItem[] } | { ok: false; reason: string } {
  if (!Array.isArray(lines)) return { ok: false, reason: "expected an array" };
  if (lines.length < 1 || lines.length > MAX_LINE_ITEMS) {
    return { ok: false, reason: `expected 1..${MAX_LINE_ITEMS} lines, got ${lines.length}` };
  }

  const items: IdpLineItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as ApprovalLine;
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: `line ${i} is not an object` };
    }

    const name = typeof raw.item_name === "string" ? raw.item_name.trim() : "";
    if (name.length < 1 || name.length > MAX_NAME_LEN) {
      return { ok: false, reason: `line ${i} name must be 1..${MAX_NAME_LEN} characters` };
    }

    const qtyBase = Number(raw.qty_base);
    if (!Number.isFinite(qtyBase) || qtyBase <= 0) {
      return { ok: false, reason: `line ${i} qty_base must be a number > 0` };
    }

    const caseQty = Number(raw.case_qty);
    const quantity = isCaseRow(caseQty) ? Math.ceil(qtyBase / caseQty) : qtyBase;
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
      return { ok: false, reason: `line ${i} quantity must be > 0 and <= ${MAX_QUANTITY}` };
    }

    const displayText = isCaseRow(caseQty)
      ? `${quantity} case(s) of ${caseQty} · ${name}`
      : name;

    items.push({
      name,
      display_text: displayText.slice(0, MAX_NAME_LEN),
      // IDP DRIFT #1 (see header): quantity/unit directly on the LineItem are
      // deprecated as of 2026-03-18; line_item_measurements is the current
      // shape. 'each' is a documented Countable-Items unit — cases are conveyed
      // through display_text, not through a unit (there is no 'case' unit).
      line_item_measurements: [{ quantity, unit: "each" }],
    });
  }

  return { ok: true, items };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Design guidance 7 — one correlation id per request, echoed in every error
  // body and in every log line. Logs carry ONLY: correlationId, approvalId,
  // HTTP status, upstream status, elapsed ms. Never the API key, never the full
  // request body, never the returned URL.
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();

  const gate = await requireAdminCaller(req.headers.get("Authorization"));
  if (gate.status !== 200) {
    console.warn(
      `instacart-cart-link denied cid=${correlationId} status=${gate.status} ms=${Date.now() - startedAt}`,
    );
    return json({ ok: false, error: gate.error, correlationId }, gate.status);
  }
  const client = gate.client;

  let approvalId = "";
  try {
    const body = await req.json().catch(() => ({}));
    approvalId = typeof body?.approvalId === "string" ? body.approvalId.trim() : "";
  } catch {
    approvalId = "";
  }
  if (!approvalId || !UUID_RE.test(approvalId)) {
    return json({ ok: false, error: "approvalId required", correlationId }, 400);
  }

  try {
    // ─── AC-24: every read below rides the CALLER's token; RLS clips it. ────
    // NOTE the ordering: every authorization / state refusal (404, 409) is
    // resolved BEFORE the INSTACART_IDP_API_KEY check further down. A
    // misconfigured deployment must not turn the cross-store refusal into a
    // generic 500 — the AC-24 smoke has to be exercisable without a live key.
    const { data: approval } = await client
      .from("order_approvals")
      .select(
        "id, store_id, vendor_id, business_date, channel, status, lines, external_ref, external_ref_expires_at",
      )
      .eq("id", approvalId)
      .maybeSingle();

    // RLS-hidden or absent — indistinguishable BY DESIGN. This is the
    // cross-store refusal (AC-24); no upstream contact has happened.
    if (!approval) {
      console.warn(`instacart-cart-link cid=${correlationId} approval=${approvalId} status=404`);
      return json({ ok: false, error: "approval not found", correlationId }, 404);
    }

    if (approval.status === "ordered") {
      return json({ ok: false, error: "already_ordered", correlationId }, 409);
    }
    if (approval.channel !== "instacart") {
      return json(
        { ok: false, error: "wrong_channel", channel: approval.channel as OrderChannel, correlationId },
        409,
      );
    }

    // ─── Idempotency (design guidance 6 / OQ-6) ────────────────────────────
    // A live link is REUSED with no upstream call. An expired one is re-minted
    // because the user pressed the button — never a silent auto-regeneration.
    const existingExpiry = approval.external_ref_expires_at
      ? Date.parse(approval.external_ref_expires_at as string)
      : NaN;
    if (approval.external_ref && Number.isFinite(existingExpiry) && existingExpiry > Date.now()) {
      console.log(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} status=200 reused=true ms=${Date.now() - startedAt}`,
      );
      return json(
        {
          ok: true,
          approvalId,
          url: approval.external_ref,
          expiresAt: approval.external_ref_expires_at,
          reused: true,
          correlationId,
        },
        200,
      );
    }

    // Vendor + store context — also caller-token reads. A vendor or store the
    // caller cannot see collapses into the same 404 as a hidden approval; the
    // refusal must not leak which half was invisible.
    const { data: vendor } = await client
      .from("vendors")
      .select("id, name, instacart_retailer_key, extension_ordering")
      .eq("id", approval.vendor_id)
      .maybeSingle();
    const { data: store } = await client
      .from("stores")
      .select("id, name, postal_code")
      .eq("id", approval.store_id)
      .maybeSingle();
    if (!vendor || !store) {
      return json({ ok: false, error: "approval not found", correlationId }, 404);
    }

    // R-3's fallback: BJ's / Sam's both already have cart-filler adapters.
    const fallbackChannel: OrderChannel = vendor.extension_ordering ? "extension" : "manual";

    // ─── AC-27 validation, BEFORE any upstream call ────────────────────────
    const built = buildLineItems(approval.lines);
    if (!built.ok) {
      return json({ ok: false, error: `invalid lines: ${built.reason}`, correlationId }, 400);
    }

    // ─── OQ-2 / §5.5: retailer availability for the store's real ZIP ───────
    const postalCode =
      typeof store.postal_code === "string" && store.postal_code.trim()
        ? store.postal_code.trim()
        : null;
    const retailerKey =
      typeof vendor.instacart_retailer_key === "string" && vendor.instacart_retailer_key.trim()
        ? vendor.instacart_retailer_key.trim()
        : null;

    if (!postalCode || !retailerKey) {
      // Step 1 short-circuit: no ZIP (or the key was cleared after approval) ⇒
      // no products_link call is made.
      return json(
        { ok: false, error: "retailer_unavailable", fallbackChannel, postalCode, correlationId },
        409,
      );
    }

    // AC-22 — the secret gate. Deliberately the LAST check before the first
    // outbound call: a misconfiguration is not a caller error, and it must not
    // pre-empt any of the refusals above. Never echo the (absent) key.
    if (!INSTACART_IDP_API_KEY) {
      console.error(`instacart-cart-link cid=${correlationId} INSTACART_IDP_API_KEY not configured`);
      return json({ ok: false, error: "not_configured", correlationId }, 500);
    }

    const retailersUrl =
      `${INSTACART_IDP_BASE_URL}/idp/v1/retailers` +
      `?postal_code=${encodeURIComponent(postalCode)}&country_code=US`;
    const retailersRes = await idpFetch(retailersUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${INSTACART_IDP_API_KEY}`,
        Accept: "application/json",
      },
    });
    if (!retailersRes.ok) {
      console.error(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} upstream=retailers upstreamStatus=${retailersRes.status} ms=${Date.now() - startedAt}`,
      );
      return json(
        { ok: false, error: "upstream_error", upstreamStatus: retailersRes.status, correlationId },
        502,
      );
    }
    const retailersBody = await retailersRes.json().catch(() => null);
    const availableKeys = new Set<string>(
      (Array.isArray(retailersBody?.retailers) ? retailersBody.retailers : [])
        .map((r: { retailer_key?: unknown }) => (typeof r?.retailer_key === "string" ? r.retailer_key : ""))
        .filter(Boolean),
    );
    if (!availableKeys.has(retailerKey)) {
      // Step 3: the vendor's retailer does not serve this ZIP. NO products_link
      // call is made — never open a link that lands on an empty retailer.
      console.warn(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} status=409 retailer_unavailable ms=${Date.now() - startedAt}`,
      );
      return json(
        { ok: false, error: "retailer_unavailable", fallbackChannel, postalCode, correlationId },
        409,
      );
    }

    // ─── Mint ──────────────────────────────────────────────────────────────
    const title = [store.name, vendor.name, approval.business_date].filter(Boolean).join(" · ");
    const payload: Record<string, unknown> = {
      title,
      link_type: "shopping_list",
      expires_in: LINK_EXPIRES_IN_DAYS,
      instructions: ["Review quantities before checkout."],
      line_items: built.items,
    };
    if (INSTACART_PARTNER_LINKBACK_URL) {
      // enable_pantry_items is deliberately omitted — the docs mark it
      // recipe-link_type only (IDP DRIFT #2 in the header).
      payload.landing_page_configuration = {
        partner_linkback_url: INSTACART_PARTNER_LINKBACK_URL,
      };
    }

    const mintRes = await idpFetch(`${INSTACART_IDP_BASE_URL}/idp/v1/products/products_link`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INSTACART_IDP_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!mintRes.ok) {
      console.error(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} upstream=products_link upstreamStatus=${mintRes.status} ms=${Date.now() - startedAt}`,
      );
      return json(
        { ok: false, error: "upstream_error", upstreamStatus: mintRes.status, correlationId },
        502,
      );
    }
    const mintBody = await mintRes.json().catch(() => null);
    const url = typeof mintBody?.products_link_url === "string" ? mintBody.products_link_url : "";
    if (!url) {
      // A 2xx without the documented key is NOT a success. AC-15 forbids a
      // silent fake success here.
      console.error(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} upstream=products_link upstreamStatus=${mintRes.status} missing products_link_url`,
      );
      return json(
        { ok: false, error: "upstream_error", upstreamStatus: mintRes.status, correlationId },
        502,
      );
    }

    // ─── Write-back through the CALLER-token client (RLS + the §1.2 trigger
    //     both apply). pending → approved is legal; an already-'approved' row
    //     takes the legal no-op self-transition.
    const expiresAt = new Date(
      Date.now() + LINK_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: writeErr } = await client
      .from("order_approvals")
      .update({
        external_ref: url,
        external_ref_expires_at: expiresAt,
        status: "approved",
      })
      .eq("id", approvalId);
    if (writeErr) {
      console.error(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} writeback_failed code=${writeErr.code ?? ""}`,
      );
      return json({ ok: false, error: "writeback_failed", correlationId }, 500);
    }

    console.log(
      `instacart-cart-link cid=${correlationId} approval=${approvalId} status=200 reused=false upstreamStatus=${mintRes.status} ms=${Date.now() - startedAt}`,
    );
    return json({ ok: true, approvalId, url, expiresAt, reused: false, correlationId }, 200);
  } catch (e) {
    if (e instanceof UpstreamTimeout) {
      console.error(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} upstream_timeout ms=${Date.now() - startedAt}`,
      );
      return json({ ok: false, error: "upstream_timeout", correlationId }, 504);
    }
    console.error(
      `instacart-cart-link cid=${correlationId} approval=${approvalId} uncaught ms=${Date.now() - startedAt}`,
    );
    return json({ ok: false, error: "unexpected_error", correlationId }, 500);
  }
});
