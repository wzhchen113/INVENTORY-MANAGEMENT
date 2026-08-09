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
//   DRIFT #3 — *** ESCALATED, AND ACCEPTED BY THE OWNER (spec 155) ***:
//     THERE IS NO RETAILER-PINNING FIELD on products_link (or on the recipe
//     endpoint) in the current API. No retailer_key / retailer_id / preferred-
//     retailer parameter exists in either request body, and the Shopping list
//     page concept doc states plainly: "On the shopping list page, the user
//     selects their preferred store". The changelog's only preferred-retailer
//     entry (2025-04-17, recipe pages) is no longer reflected in the reference.
//     Spec 149 surfaced this to the PM rather than working around it; spec 155
//     records the owner's decision: ACCEPTED.
//     ⇒ The minted link opens a pre-filled shopping list on which the ADMIN
//       PICKS THE RETAILER. That extra tap is accepted, and the Approve Order
//       screen DISCLOSES it (section.approveOrder.instacartPicker, spec 155
//       AC-9). Do NOT attempt to recover pinning — the mechanism does not exist
//       upstream (reconciled against the live docs 2026-08-01).
//     ⇒ vendors.instacart_retailer_key is ADVISORY METADATA + the explicit
//       OPT-IN TOKEN — it is NOT a pinning mechanism. Because the minted link is
//       retailer-agnostic, the key's absence from a market listing predicts
//       NOTHING about whether the link works. That is exactly why the §5.5
//       availability probe below is ADVISORY and never refuses (spec 155 AC-13 /
//       AC-14 / AC-15): it answers "is Instacart in this market at all", which is
//       worth knowing and not worth blocking an order over.
//     ⇒ R-3 precedence is UNCHANGED (spec 155 AC-REG-2): public.vendor_order_channel()
//       resolves 'instacart' only when order_channel='instacart' AND the retailer
//       key is non-blank. The key is still load-bearing — as a SWITCH, not as a
//       PIN. A blank key at mint time is therefore still a refusal (409
//       retailer_unavailable + reason='blank_retailer_key', spec 155 AC-16); the
//       operator has de-opted the vendor out of the channel and the cart-filler
//       fallback is the correct destination.
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
// Spec 155 §4.4 — the retailers probe is ADVISORY, so it gets its own, much
// smaller budget: its result no longer gates correctness and a hung probe must
// not spend a third of the caller's patience on advice. Without this the
// worst-case path after the demotion would be 10s (probe) + 10s (mint) ≈ 20s on
// a request that previously bailed at 10s; with it the ceiling is ~13s.
// Both budgets cover the RESPONSE BODY READ, not just the headers — see idpFetch
// (post-review S4). Without that, the ~13s ceiling was not actually guaranteed.
const RETAILERS_PROBE_TIMEOUT_MS = 3_000;
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

// Spec 155 §3.2 (OQ-5) — the advisory transport. An OPTIONAL string field on the
// existing 200 body; OMITTED (never null, never "") when the probe was clean.
// Stable tokens: the shell smoke asserts them and src/lib/db.ts type-guards
// them, dropping anything it does not recognize.
type Advisory = "no_postal_code" | "retailer_not_in_zip" | "retailers_probe_failed";

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
// Spec 155 §4.4 (post-review S4) — a malformed body is NOT a timeout and NOT a
// transport fault. Carried as its own class purely so the probe's log line can
// say cause=parse (see the probe catch below).
class UpstreamParseError extends Error {}

function isAbortError(e: unknown): boolean {
  const name = (e as Error)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

// ★ Spec 155 §4.4 (post-review S4) — THE DEADLINE MUST COVER THE BODY READ.
// The spec-149 shape cleared the abort timer as soon as `fetch` resolved, i.e.
// at RESPONSE HEADERS. An upstream that answers 200 and then stalls the body
// hung `await res.json()` with no deadline at all — for the advisory probe that
// is §11 risk 2 arriving through the back door (a demoted probe killing a mint),
// and for products_link it silently voided the 10s budget.
//
// So idpFetch no longer returns a bare Response: it hands back a small handle
// whose `json()` runs under the SAME AbortController, and the timer is cleared
// only once the body has settled (or `done()` is called). Callers MUST call
// `done()` in a `finally` — it clears the timer and discards an unread body.
type IdpCall = {
  res: Response;
  /** Reads + parses the body under the same deadline as the fetch. */
  json: () => Promise<unknown>;
  /** Clears the deadline and discards an unread body. Always safe to re-call. */
  done: () => Promise<void>;
};

async function idpFetch(
  url: string,
  init: RequestInit,
  // Spec 155 §4.4 — per-call budget. products_link keeps the 10s default; the
  // advisory retailers probe passes RETAILERS_PROBE_TIMEOUT_MS.
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<IdpCall> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timer);
  };

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    clear();
    if (isAbortError(e)) throw new UpstreamTimeout();
    throw e;
  }

  return {
    res,
    json: async () => {
      try {
        return await res.json();
      } catch (e) {
        // The abort lands here as an errored body stream once the timer fires
        // mid-read — that is the stalled-body case, and it is a TIMEOUT.
        if (isAbortError(e) || ac.signal.aborted) throw new UpstreamTimeout();
        // Anything else is a malformed payload, not a transport fault.
        throw new UpstreamParseError((e as Error)?.message ?? "unparseable body");
      } finally {
        clear();
      }
    },
    done: async () => {
      clear();
      try {
        // No-op when the body was already consumed or errored.
        if (!res.bodyUsed) await res.body?.cancel();
      } catch {
        // Discarding an unread body is best-effort; never let it mask the
        // real outcome.
      }
    },
  };
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

    // ─── §5.5 retailer availability — ADVISORY since spec 155 ──────────────
    const postalCode =
      typeof store.postal_code === "string" && store.postal_code.trim()
        ? store.postal_code.trim()
        : null;
    const retailerKey =
      typeof vendor.instacart_retailer_key === "string" && vendor.instacart_retailer_key.trim()
        ? vendor.instacart_retailer_key.trim()
        : null;

    // Spec 155 AC-16 — the ONE availability arm that still refuses. A blank key
    // means the operator has de-opted this vendor OUT of the channel (R-3 would
    // not resolve 'instacart' for it either), so the cart-filler fallback is the
    // correct destination — not a mint.
    //
    // The wire token stays 'retailer_unavailable' DELIBERATELY (§4.2): AC-16
    // requires distinguishability in LOGS, not on the wire, and reusing the
    // token keeps the client's spec-149 409 → fallbackChannel branch live across
    // the deploy-skew window (AC-18) instead of turning it into dead code. The
    // two DEMOTED arms below never reach 409 at all, so the log sets are
    // disjoint by construction. `reason` is additive, for logs/smoke only — the
    // client ignores it and src/lib/db.ts does not surface it.
    if (!retailerKey) {
      console.warn(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} status=409 retailer_unavailable reason=blank_retailer_key ms=${Date.now() - startedAt}`,
      );
      return json(
        {
          ok: false,
          error: "retailer_unavailable",
          fallbackChannel,
          postalCode,
          reason: "blank_retailer_key",
          correlationId,
        },
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

    // ─── The demoted probe (spec 155 AC-13 / AC-14 / AC-15) ────────────────
    // NOTHING below this line can refuse the mint. Every outcome — no ZIP, a
    // dead probe, a key that is not in the market listing, an empty market —
    // resolves to at most an advisory token on the 200 body. The link is
    // retailer-agnostic (DRIFT #3 in the header), so the probe predicts nothing
    // about whether the mint works; it only answers "is Instacart in this market
    // at all", which is worth telling the operator and not worth blocking on.
    let advisory: Advisory | null = null;

    if (!postalCode) {
      // AC-13 — a null/blank stores.postal_code SKIPS the probe entirely. This
      // was a 409 short-circuit before spec 155.
      advisory = "no_postal_code";
      console.warn(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} advisory=no_postal_code ms=${Date.now() - startedAt}`,
      );
    } else {
      // ★ Spec 155 §4.4 / risk 2 — the ENTIRE probe (fetch, .json(), and the
      // availableKeys construction) is wrapped in its own try/catch so a probe
      // UpstreamTimeout can NEVER reach the outer catch and become a 504. A
      // slow ADVISORY probe killing a mint that would have succeeded is the
      // demotion inverted, and an AC-15 failure. Do not unwrap this.
      try {
        const retailersUrl =
          `${INSTACART_IDP_BASE_URL}/idp/v1/retailers` +
          `?postal_code=${encodeURIComponent(postalCode)}&country_code=US`;
        const probe = await idpFetch(
          retailersUrl,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${INSTACART_IDP_API_KEY}`,
              Accept: "application/json",
            },
          },
          RETAILERS_PROBE_TIMEOUT_MS,
        );
        try {
          if (!probe.res.ok) {
            // AC-15 — a non-2xx on the PROBE is advice, not a failure. (A non-2xx
            // on products_link below keeps its 502; that one is a real failure.)
            advisory = "retailers_probe_failed";
            console.warn(
              `instacart-cart-link cid=${correlationId} approval=${approvalId} advisory=retailers_probe_failed upstream=retailers upstreamStatus=${probe.res.status} ms=${Date.now() - startedAt}`,
            );
          } else {
            // Deliberately NOT .catch(() => null): an unparseable body is a probe
            // failure (§3.2), not an empty market. Letting it throw into the local
            // catch below keeps `retailers=0` meaning exactly "Instacart does not
            // serve this market" (§4.3). Same reasoning for a body whose
            // `retailers` is not an array.
            //
            // S4: probe.json() runs under the SAME 3s deadline as the fetch, so a
            // 200-then-stalled body aborts at the budget instead of hanging the
            // mint behind an advisory read.
            const retailersBody = (await probe.json()) as { retailers?: unknown } | null;
            if (!Array.isArray(retailersBody?.retailers)) {
              throw new UpstreamParseError("retailers payload is not an array");
            }
            const retailers = retailersBody.retailers as Array<{ retailer_key?: unknown }>;
            const availableKeys = new Set<string>(
              retailers
                .map((r) => (typeof r?.retailer_key === "string" ? r.retailer_key : ""))
                .filter(Boolean),
            );
            if (!availableKeys.has(retailerKey)) {
              // AC-14 + OQ-3 — the key is absent from the listing, OR the market
              // is empty. Both share this token: with no retailer pinning they
              // produce the SAME operator action (proceed; if it repeats, check
              // the ZIP). Distinguishability lives in the log line's retailers=<n>
              // — retailers=0 is the "Instacart does not serve this market at all"
              // signal (§4.3). No ZIP, no key, no URL in any log line.
              advisory = "retailer_not_in_zip";
              console.warn(
                `instacart-cart-link cid=${correlationId} approval=${approvalId} advisory=retailer_not_in_zip retailers=${retailers.length} ms=${Date.now() - startedAt}`,
              );
            }
          }
        } finally {
          // Clears the 3s deadline and discards an unread body (the non-2xx arm
          // never reads one). Without this the timer would sit until it fires.
          await probe.done();
        }
      } catch (probeErr) {
        advisory = "retailers_probe_failed";
        // Post-review M2 — one-line field diagnosis (runbook step 5.9):
        //   timeout = the probe blew its 3s budget (connect, headers, OR body);
        //   parse   = 2xx with a body that is not the documented shape;
        //   network = DNS / TLS / connection-level fault.
        // `timeout=` is kept verbatim alongside it: it predates this fix and the
        // smoke/runbook grep for it.
        const cause = probeErr instanceof UpstreamTimeout
          ? "timeout"
          : probeErr instanceof UpstreamParseError
          ? "parse"
          : "network";
        console.warn(
          `instacart-cart-link cid=${correlationId} approval=${approvalId} advisory=retailers_probe_failed upstream=retailers cause=${cause} timeout=${probeErr instanceof UpstreamTimeout} ms=${Date.now() - startedAt}`,
        );
      }
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

    const mintCall = await idpFetch(`${INSTACART_IDP_BASE_URL}/idp/v1/products/products_link`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INSTACART_IDP_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const mintRes = mintCall.res;
    if (!mintRes.ok) {
      await mintCall.done();
      console.error(
        `instacart-cart-link cid=${correlationId} approval=${approvalId} upstream=products_link upstreamStatus=${mintRes.status} ms=${Date.now() - startedAt}`,
      );
      return json(
        { ok: false, error: "upstream_error", upstreamStatus: mintRes.status, correlationId },
        502,
      );
    }
    // S4: the body read stays inside the 10s budget. An UpstreamTimeout raised
    // HERE is a real products_link timeout and must reach the outer 504 arm
    // (§3.2) — so it is deliberately NOT swallowed the way an unparseable body
    // is (that one falls through to the missing-url 502 below).
    let mintBody: { products_link_url?: unknown } | null = null;
    try {
      mintBody = (await mintCall.json()) as { products_link_url?: unknown } | null;
    } catch (mintErr) {
      if (mintErr instanceof UpstreamTimeout) throw mintErr;
      mintBody = null;
    } finally {
      await mintCall.done();
    }
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

    // Post-review M1 — `advisory=<token|none>` on the TERMINAL line so an
    // outcome can be correlated with its advice by a single-line grep instead of
    // a join on cid. Still no ZIP, no key, no URL.
    console.log(
      `instacart-cart-link cid=${correlationId} approval=${approvalId} status=200 reused=false upstreamStatus=${mintRes.status} advisory=${advisory ?? "none"} ms=${Date.now() - startedAt}`,
    );
    return json(
      {
        ok: true,
        approvalId,
        url,
        expiresAt,
        reused: false,
        correlationId,
        // Spec 155 §3.2 — OMITTED when the probe was clean. Never null, never "".
        ...(advisory ? { advisory } : {}),
      },
      200,
    );
  } catch (e) {
    // Spec 155 §4.4 — the ONLY idpFetch that can still land here is the
    // products_link mint: the advisory probe swallows its own UpstreamTimeout
    // above. A probe timeout arriving as a 504 is an AC-15 failure.
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
