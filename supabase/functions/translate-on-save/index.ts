// supabase/functions/translate-on-save/index.ts
//
// Spec 040 P3b — auto-translate a canonical English name (an ingredient,
// recipe, prep recipe, or category) into one or more target locales via
// DeepL's free-tier v2 API. Returns a `{ translations: { es?, 'zh-CN'? } }`
// envelope; the client-side form merges the suggestions into manual-
// override fields the user can edit before saving.
//
// Contract (architect's design, §4):
//
//   Request:
//     POST /functions/v1/translate-on-save
//     Authorization: Bearer <user JWT>
//     Content-Type: application/json
//     { "text": string,
//       "sourceLocale": "en",                          // pinned literal for v1
//       "targetLocales": ("es" | "zh-CN")[] }          // 1 or 2 items
//
//   Response (success):
//     200 { "translations": { "es"?: string, "zh-CN"?: string } }
//     Keys missing from `translations` = DeepL declined that target; the
//     form falls through to a manual-override input for that locale.
//
//   Response (failure):
//     400 { "error": "text required" | "text too long" | "targetLocales required"
//                  | "unsupported source locale" | "unsupported target locale" }
//     401 { "error": "missing bearer token" | "invalid token" }
//     403 { "error": "forbidden" }
//     503 { "error": "translation_unavailable" }    -- DEEPL_API_KEY unset OR
//                                                       DeepL quota/auth/5xx/network.
//                                                       All upstream failure modes
//                                                       collapse to this single
//                                                       string so the form doesn't
//                                                       render per-code UI.
//
// verify_jwt: TRUE (default — no entry needed in supabase/config.toml; the
// file only flags exceptions). Caller authorization is gated by
// requireAdminCaller() mirroring auth_is_privileged() per CLAUDE.md.
//
// Inlined-not-shared helpers (requireAdminCaller) per spec 027 §4.2 —
// supabase functions deploy <name> ships one function at a time, so a
// shared _shared/ module is invisible drift surface. Byte-identical
// mirror exists in delete-user (requireAdminCaller) and send-invite-email.
// No escapeHtml helper in this function — see the rationale block at the
// translateOne() return.
//
// DeepL provider notes:
//   - We pin api-free.deepl.com (per spec 040 §Out of scope; Pro is a future
//     env-var flip, not in v1).
//   - LOCALE_TO_DEEPL pins ZH-HANS (Simplified) per OQ-A3; DeepL's 2024
//     v2 split moved legacy `ZH` to `ZH-HANS` / `ZH-HANT`.
//   - One DeepL request per target locale (DeepL `text` is repeatable but
//     `target_lang` is singular per request); parallelized via Promise.all
//     to save ~200ms of form-spinner perceived latency on the 2-locale case.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const DEEPL_API_KEY = Deno.env.get("DEEPL_API_KEY");
const DEEPL_API_URL = "https://api-free.deepl.com/v2/translate";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Mirror of `public.auth_is_privileged()` on the edge-function side.
// Reference shape: supabase/functions/delete-user/index.ts:19. Must include
// `super_admin` per spec 026 Track A so role-broadened RLS callers don't get
// 403'd at the edge layer.
const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);

// OQ-A3 — DeepL v2 target-lang codes for the locales we support.
// Spanish = `ES`; Chinese (Simplified) = `ZH-HANS` (the legacy `ZH` alias
// still works but the explicit form insulates us from a future DeepL
// deprecation of the alias).
const LOCALE_TO_DEEPL: Record<string, string> = {
  "es": "ES",
  "zh-CN": "ZH-HANS",
};

// NOTE: this function deliberately does NOT escape HTML on the DeepL
// output. The CLAUDE.md "Edge function HTML email templates escape
// interpolated values" rule applies to HTML email bodies (spec 028,
// send-invite-email); this function returns JSON only and its consumers
// are React Native `<Text>` / `<TextInput>` components that never
// interpret HTML. Escaping here would entity-encode names containing
// `& < > " '` (e.g. `Mom's Onion Rings` → `Mom&#39;s Onion Rings`)
// directly into the JSONB column. The architect's design §4 calls this
// out explicitly: "The text we receive back FROM DeepL is consumed as a
// JSON string and propagated to client form state — never rendered as
// raw HTML by the form." DeepL plaintext is returned verbatim.

async function requireAdminCaller(
  authHeader: string | null,
): Promise<{ status: 200; userId: string } | { status: 401 | 403; error: string }> {
  if (!authHeader?.startsWith("Bearer ")) return { error: "missing bearer token", status: 401 };
  const token = authHeader.slice(7);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userRes, error: userErr } = await client.auth.getUser();
  if (userErr || !userRes?.user) return { error: "invalid token", status: 401 };
  const appRole = (userRes.user.app_metadata as any)?.role;
  if (ADMIN_ROLES.has(appRole)) return { userId: userRes.user.id, status: 200 };
  const { data: profile } = await client.from("profiles").select("role").eq("id", userRes.user.id).single();
  if (!profile || !ADMIN_ROLES.has(profile.role)) return { error: "forbidden", status: 403 };
  return { userId: userRes.user.id, status: 200 };
}

// Validate the request body. Returns either a structured error response or
// the parsed shape. The 200-char cap is the architect's call (§4) — name-
// length is bounded by the UI today, but a server-side cap prevents a
// malicious caller from burning 5000 chars of DeepL quota on a single call.
function validateRequest(body: unknown): { error: string; status: 400 } | {
  text: string;
  targetLocales: string[];
} {
  if (typeof body !== "object" || body === null) {
    return { error: "invalid request body", status: 400 };
  }
  const b = body as Record<string, unknown>;

  const text = b.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return { error: "text required", status: 400 };
  }
  if (text.length > 200) {
    return { error: "text too long", status: 400 };
  }

  // Spec 040 §4 — sourceLocale must be 'en' when present. The original
  // `!== undefined` check accidentally permitted callers to omit the field
  // OR pass `null`; both are out-of-contract and reject here.
  const sourceLocale = b.sourceLocale;
  if (sourceLocale !== undefined && sourceLocale !== null && sourceLocale !== "en") {
    return { error: "unsupported source locale", status: 400 };
  }

  const targetLocales = b.targetLocales;
  if (!Array.isArray(targetLocales) || targetLocales.length === 0) {
    return { error: "targetLocales required", status: 400 };
  }
  for (const loc of targetLocales) {
    if (typeof loc !== "string" || !(loc in LOCALE_TO_DEEPL)) {
      return { error: "unsupported target locale", status: 400 };
    }
  }

  return { text, targetLocales: targetLocales as string[] };
}

// Per-locale DeepL call. Returns the translated string on success or null on
// any upstream failure mode (auth, quota, rate-limit, network, malformed
// response). The caller collapses null → "key absent from translations" so
// the form can fall through to manual-override input on that locale only.
async function translateOne(text: string, locale: string): Promise<string | null> {
  if (!DEEPL_API_KEY) return null;
  const deeplLang = LOCALE_TO_DEEPL[locale];
  if (!deeplLang) return null;

  // DeepL v2 expects application/x-www-form-urlencoded — auth_key, text,
  // source_lang, target_lang. URLSearchParams handles encoding correctly.
  const form = new URLSearchParams();
  form.set("auth_key", DEEPL_API_KEY);
  form.set("text", text);
  form.set("source_lang", "EN");
  form.set("target_lang", deeplLang);

  let res: Response;
  try {
    res = await fetch(DEEPL_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (e) {
    console.warn("[translate-on-save] DeepL network error", locale, (e as Error).message);
    return null;
  }

  if (!res.ok) {
    // 403 = auth failure (bad key), 456 = quota exhausted, 429 = rate limit,
    // 5xx = DeepL outage. We log the status for ops visibility but collapse
    // all of them to "null" so the client doesn't fingerprint DeepL's
    // failure modes. The 503 + "translation_unavailable" envelope is set by
    // the top-level handler only when EVERY target fails.
    console.warn(`[translate-on-save] DeepL non-2xx ${res.status} for ${locale}`);
    return null;
  }

  let parsed: any;
  try {
    parsed = await res.json();
  } catch (e) {
    console.warn("[translate-on-save] DeepL response parse error", locale, (e as Error).message);
    return null;
  }

  // DeepL response shape: { translations: [ { detected_source_language, text } ] }
  // Return plaintext verbatim — see comment block above re: not HTML-escaping.
  const out = parsed?.translations?.[0]?.text;
  if (typeof out !== "string" || out.length === 0) return null;
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ── Caller auth ────────────────────────────────────────────────────────
  const gate = await requireAdminCaller(req.headers.get("Authorization"));
  if (gate.status !== 200) {
    return new Response(JSON.stringify({ error: gate.error }), {
      status: gate.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Env preflight ──────────────────────────────────────────────────────
  // If DEEPL_API_KEY isn't set we short-circuit with a single 503 — the
  // form falls through to manual-override entry. The operator surface for
  // this is `supabase secrets set DEEPL_API_KEY=...` (see spec 040 §4).
  if (!DEEPL_API_KEY) {
    // Spec 040 §4 contract: collapse all upstream failure modes (including
    // missing-key) to a single client-visible "translation_unavailable" so
    // the form doesn't render per-code UI branches. Operator surface for
    // the missing-key case is the function logs + `supabase secrets set`.
    return new Response(JSON.stringify({ error: "translation_unavailable" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Request parse + validate ───────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const validated = validateRequest(body);
  if ("error" in validated) {
    return new Response(JSON.stringify({ error: validated.error }), {
      status: validated.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { text, targetLocales } = validated;

  // ── DeepL fan-out (parallel) ───────────────────────────────────────────
  // One request per target locale. Promise.all parallelizes 2 calls in
  // ~200ms instead of ~400ms — the form's translating-spinner UX target.
  // We tolerate per-locale nulls (return whichever succeeded); only
  // collapse to a 503 if EVERY locale failed.
  const settled = await Promise.all(
    targetLocales.map(async (loc) => ({
      locale: loc,
      result: await translateOne(text, loc),
    })),
  );

  const translations: Record<string, string> = {};
  for (const { locale, result } of settled) {
    if (result !== null) {
      translations[locale] = result;
    }
  }

  // All-failed → 503 with the standard fallthrough envelope. Otherwise a
  // 200 with a (possibly partial) translations object — the form fills the
  // succeeded fields and leaves the failed ones as manual-override-only.
  if (Object.keys(translations).length === 0) {
    return new Response(JSON.stringify({ error: "translation_unavailable" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ translations }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
