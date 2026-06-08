# Security audit for spec 095 (username-login) — RE-AUDIT after rate-limit fix

Reviewer: security-auditor
Date: 2026-06-07 (re-audit)
Verdict: No Critical findings. Spec is NOT blocked on security grounds. The
prior Medium-1 (no rate limit on the bundle-public-token resolver) is now
RESOLVED. The 429 does NOT reopen the enumeration oracle. One residual Low
upgraded / re-scoped (XFF spoofability of the IP key); the original Lows stand.

Scope re-reviewed for this pass:
`supabase/migrations/20260607130000_username_resolve_rate_limit.sql` (NEW),
`supabase/functions/username-resolve/index.ts` (rate-limit call added),
`supabase/tests/username_resolve_rate_limit.test.sql` (NEW), plus a re-confirm
of the original 7 anti-oracle checks against the current (line-shifted) code:
`supabase/migrations/20260607120000_profiles_username.sql` backfill,
`src/lib/auth.ts`, `supabase/config.toml`.

---

## Critical question — does the 429 reopen the enumeration oracle? NO. (verified)

The design claim holds. Three independent confirmations:

1. **The limiter never sees the username.** `index.ts:101-105` calls
   `check_username_resolve_rate_limit({ p_ip: clientIp(req) })` — the only input
   is the client IP. The username is not parsed until `:117-129`, AFTER the
   limiter runs. The migration RPC (`20260607130000:88-126`) takes a single
   `p_ip text` and keys the table on `(ip, window_start)` — the username is not a
   column, not a parameter, not in the WHERE/conflict target. So the 429 is a
   pure function of per-IP request volume, fully independent of which username
   was sent or whether any username exists.

2. **429 is reached identically for existent and non-existent usernames.** Both
   consume exactly one unit of the same per-IP budget before any lookup happens.
   An attacker cannot use the presence/absence of a 429 to distinguish
   "username exists" from "username does not exist" — the signal is "this IP is
   calling too often," nothing more.

3. **The non-429 success path is unchanged.** Every well-formed, within-budget
   request still returns `200 { email: string | null }`
   (`index.ts:124, 128, 147, 152, 155, 158`). No new status code leaks existence
   on the success path. The 429 sits strictly ABOVE the lookup, gating volume,
   not outcome.

Conclusion: 429 is a per-IP signal, not a per-username signal. The enumeration
oracle that the rest of spec 095 closes stays closed.

---

## New RPC SECURITY DEFINER review (injection / search_path) — PASS

`public.check_username_resolve_rate_limit(p_ip text)`
(`20260607130000:88-126`):

- **search_path pinned** — `set search_path = public, pg_temp`
  (`:94`). Correct hardening; `pg_temp` last avoids the temp-schema shadowing
  attack on a SECURITY DEFINER function.
- **No dynamic SQL.** No `EXECUTE`. `p_ip` flows through a bound plpgsql variable
  (`v_ip`, `:111`) into a parameterized `INSERT ... ON CONFLICT DO UPDATE ...
  RETURNING` (`:118-122`). No string concatenation into SQL → no injection
  surface even for an attacker-shaped `x-forwarded-for` value.
- **Atomic increment** — the count-and-check is a single
  `ON CONFLICT DO UPDATE ... RETURNING request_count` (`:120-122`), so
  concurrent same-IP calls cannot race past the limit (no read-modify-write gap).
- **Blank-IP collapse** — `coalesce(nullif(btrim(p_ip), ''), 'unknown')`
  (`:111`) routes a missing/blank IP into one shared `unknown` bucket: fails
  toward throttling, never toward an unbounded set of free buckets. Correct
  conservative posture.
- **Grants** — `REVOKE EXECUTE ... FROM public, anon, authenticated` then
  `GRANT EXECUTE ... TO service_role` (`:136-139`); same for
  `prune_*` (`:172-175`). anon/authenticated cannot invoke the limiter over
  PostgREST. pgTAP arm (7) (`username_resolve_rate_limit.test.sql:96-104`)
  asserts `has_function_privilege('anon', ...) = false`.

`prune_username_resolve_rate_limit()` (`:148-166`) — same hardening; bounded
`DELETE ... WHERE window_start < now() - interval '1 hour'`, no dynamic SQL, no
user input. The pg_cron block (`:179-190`) is idempotent
(`if exists ... unschedule` then `schedule`). No issue.

## New table RLS — PASS (correct posture, not a widening)

`public.username_resolve_rate_limit` (`:65-70`) has RLS ENABLED (`:80`) and NO
permissive policy. This is the right posture for an infra counter: only the
SECURITY DEFINER RPC (running as owner) and service_role's DML grants (`:144`)
can touch it; anon/authenticated see zero rows even after the RPC writes.
pgTAP arm (6) (`test:86-91`) confirms `authenticated` sees 0 rows.

Note: this is NOT store-scoped or admin-scoped data, so the absence of
`auth_can_see_store()` / `auth_is_admin()` in a policy is correct — the table is
deliberately unreachable by any session role. There is no `USING (true)` and no
permissive policy, so the spec-051/053 OR-widening lint is not engaged. Not a
finding.

---

## Re-confirmation of the original 7 anti-oracle checks (current code) — ALL PASS

1. **Uniform-200 — PASS.** `index.ts:124,128,147,152,155,158` all return
   `200 { email: ... }`. Only non-200 paths: `401` bad token (`:79`), `500`
   secret unset (`:76`), `405` non-POST (`:89`), and the NEW `429` over-budget
   (`:107`) — none of which is a per-username signal (429 analyzed above).
2. **Generic error collapse — PASS.** `auth.ts` `signIn` collapses null-resolve,
   GoTrue error, and no-user into the single `GENERIC_LOGIN_ERROR`. Unchanged by
   this fix; the resolver still returns email-or-null only.
3. **Service-token gate — PASS.** `checkAuth` (`:72-82`) gates on
   `USERNAME_RESOLVE_SERVICE_TOKEN`; `config.toml:414-415` declares
   `verify_jwt = false`. Caveat unchanged: the client token is bundle-public, so
   the gate is anti-casual-anon, not a real secret — which is exactly why the
   rate limiter was the right mitigation, and it has now landed.
4. **LIKE/ilike escaping — PASS.** `index.ts:138`
   `username.replace(/([\\%_])/g, "\\$1")` escapes `\`, `%`, `_` before
   `.ilike()`. Unchanged; still an anchored exact case-insensitive match
   equivalent to the `lower(username)` UNIQUE index. `%`/`_` cannot wildcard
   other rows.
5. **Service-role returns only email — PASS.** `:139-144` selects only `id` from
   `profiles`; `:150` `getUserById`; `:155` returns ONLY
   `userData.user.email`. No hash/tokens/other columns. No `console.*` logging
   of the email or the token in the function (verified — zero `console.*`).
6. **No RLS widening — PASS.** No new policy on `profiles`. `username` rides the
   existing spec-043 brand-scoped SELECT policy. The cross-brand
   username→email lookup is service-role inside the function only. The NEW table
   is RLS-locked (above). No permissive policy added anywhere.
7. **Backfill — no injection / no unsafe dynamic SQL — PASS.** The
   `20260607120000:170-239` `DO $$` block uses no `EXECUTE`. All values flow
   through bound plpgsql vars and parameterized comparisons
   (`lower(username) = lower(v_cand)`, `:216`). Email is read via a JOIN
   (`:184`), never string-built into SQL.
   `regexp_replace(v_local, '[^a-z0-9_.]', '', 'g')` (`:192`) strips to the
   allowed charset before any comparison, so a maliciously-shaped email
   local-part cannot inject. `WHERE username IS NULL` guard + stable
   `(created_at, id)` order → idempotent, deterministic. Post-assertion
   (`:234-238`) fails-closed on remaining NULLs.

---

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

- **[RESOLVED — was Medium-1] Rate limit on the bundle-public-token resolver.**
  The prior Medium-1 (no rate limit → scriptable username→email PII harvesting by
  a token-extractor) is now mitigated by the DB-backed fixed-window per-IP limiter
  (`20260607130000`, called at `index.ts:101-108`, 20 req/min/IP). The limiter is
  a shared, atomic, RLS-locked Postgres counter — the correct choice over an
  in-memory counter that cannot enforce a budget across stateless isolates. The
  Medium is downgraded to RESOLVED with one residual caveat tracked as Low-4
  below (XFF spoofability). No remaining Medium-severity items.

## Low

- **Low-1 (was) — Resolver timing side-channel (residual, documented).** A hit
  does an extra `getUserById` round-trip (`:150`) a miss does not (`:147`
  returns first). Only meaningful to a token-holder, who already learns existence
  from the email-or-null body. Now further blunted by the per-IP rate cap (a
  timing-oracle scan is throttled to 20/min/IP). No fix required.

- **Low-2 (was) — CORS `Access-Control-Allow-Origin: "*"`** (`index.ts:46`).
  Copied from `pwa-catalog`. No cookie/credentialed auth (token is an explicit
  Authorization header), so not a CSRF vector. Unchanged by this fix. Tightening
  to known origins is defense-in-depth, not required.

- **Low-3 (was) — `InviteUserDrawer` "username taken" heuristic** — note the
  release-proposal follow-up already narrowed this to the index name
  `/profiles_username_lower_key/i` (spec §FIXES_NEEDED follow-up). If that landed
  as described, this Low is effectively closed; cosmetic admin-UX only, no
  security boundary either way.

- **Low-4 (NEW, re-scoped from Medium-1's residual) — the per-IP limiter keys on
  a client-spoofable `x-forwarded-for` first hop** (`index.ts:63-69`). An
  attacker who rotates the `X-Forwarded-For` header can mint fresh buckets and
  evade the 20/min cap, partially defeating the harvesting mitigation. This is an
  inherent limitation of XFF-based limiting at the Supabase edge (the gateway
  appends rather than strips, and the real client IP is not otherwise exposed to
  the function), and the design acknowledges IP-based limiting as best-effort. It
  still raises the cost of naive scripted harvesting and does NOT reopen the
  enumeration oracle (the username is never part of the key). Severity Low: the
  underlying exposure is email PII for a token-holder against a small,
  restaurant-staff user set, not credential bypass — the login oracle stays fully
  closed and the password bar is unchanged. Acceptable to ship; if the platform
  ever exposes a trustworthy client-IP header (e.g. a gateway-stamped
  `cf-connecting-ip`-style value that the function can trust over XFF), prefer it.
  Documenting so the residual is assessed explicitly rather than assumed away.

- **Low-5 (NEW, informational) — limiter fails OPEN on RPC error**
  (`index.ts:106` `if (!rlErr && allowed === false)`; the `catch` at `:109-112`
  swallows). This is the correct availability tradeoff (an infra blip must not
  cause a login outage) and is documented. The residual — an attacker who can
  reliably induce service-role RPC errors bypasses throttling — is not a
  practical primitive and reduces to the same Low-4 surface. No change required;
  noted for completeness.

---

## Secrets handling — PASS (unchanged + new RPC adds none)

- `USERNAME_RESOLVE_SERVICE_TOKEN` via `Deno.env.get` (`index.ts:43`), never
  logged, never returned (500 path returns only a static string, `:76`).
- The new migration reads/writes no secrets; the limiter RPC takes only an IP.
- The new limiter call adds no logging of token/email/PII (`:101-112` logs
  nothing).
- `EXPO_PUBLIC_USERNAME_RESOLVE_TOKEN` is correctly `EXPO_PUBLIC_*` (must ship to
  the pre-auth client) — public by design; what it protects is now backstopped by
  the rate limiter.

## Dependencies

No `package.json` / `package-lock.json` changes in this spec (confirmed via
`git status` / `git log`) — `npm audit` skipped.
