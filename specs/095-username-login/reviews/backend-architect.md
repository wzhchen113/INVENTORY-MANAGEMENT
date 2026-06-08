# Spec 095 — backend-architect drift review

Mode: post-implementation drift review (architect who authored the Backend
design). This pass FOCUSES on the rate-limiter fix that landed after the
original design — `20260607130000_username_resolve_rate_limit.sql` plus the
limiter call wired into `username-resolve/index.ts`. The eight original-design
verification points from the prior pass are unchanged and still MATCH; they are
not re-litigated here (see the version-control history of this file if needed —
this overwrite preserves their verdict in the summary table).

Verdict: **No Critical drift. No Should-fix drift. 4 Minor observations.**

The DB-backed limiter is the right boundary, the RPC/RLS posture matches the
project's privileged-RPC convention (it is a near-clone of
`record_missed_orders_for_day`'s grant + cron shape), and it does NOT reopen the
anti-oracle contract that is the headline risk of this spec. The four notes
below are advisory.

---

## The four questions asked

### Q1. DB-backed shared counter vs in-memory — CORRECT boundary

The rationale in the migration header (`:15-24`) and the function comment
(`:27-36`) is sound and I endorse it. Supabase edge functions are stateless Deno
isolates that scale horizontally and recycle on cold start; an in-memory counter
(a) resets to zero on every cold start, giving an attacker a fresh budget per
isolate spin-up, and (b) is never shared across concurrently-running isolates,
so the "20/min" ceiling is really "20/min × N isolates" — i.e. no real ceiling.
Deno KV is not a guaranteed primitive in the Supabase edge runtime, so it is
correctly ruled out.

A single Postgres table + SECURITY DEFINER RPC is the only place in this stack
that can hold a *shared, atomic* per-IP budget. The choice also reuses the
function's already-open service-role client (`index.ts:95` hoists the client
above the limiter call), so the limiter adds one round-trip on the SAME
connection path rather than a new dependency. This is the same model already in
the codebase for cron/service-role-only RPCs (`record_missed_orders_for_day`,
the staff RPCs). Right call, well-justified.

The atomicity is genuinely correct: `INSERT … ON CONFLICT DO UPDATE … RETURNING
request_count` (`:118-122`) increments-and-reads in one statement, so two
concurrent same-IP requests cannot both read a stale count and slip past the
limit. This is the correct primitive for a fixed-window counter and is the part
most implementations get wrong — good.

### Q2. RPC contract / RLS posture vs convention — MATCHES

Compared against the project's privileged-RPC reference shape
(`record_missed_orders_for_day`, `20260530000000`):

- `security definer` + `set search_path = public, pg_temp` — matches (`:93-94`).
- `revoke execute … from public, anon, authenticated` then `grant execute … to
  service_role` (`:136-139`) — matches the convention. The limiter RPC grants to
  `service_role` only (no `postgres` in the grant list); the prune RPC grants to
  `postgres, service_role` (`:174-175`). That asymmetry is CORRECT: the limiter
  is called only by the edge function (service-role), while the prune RPC is
  called by pg_cron (which runs as `postgres`) — so each grant list is exactly
  the set of real callers. This is tighter and more precise than a copy-paste
  would have been.
- Table RLS: `enable row level security` with NO policy (`:80`) → anon /
  authenticated cannot read or write the counter table via PostgREST, while the
  SECURITY DEFINER RPC (running as owner) and the explicit `service_role` table
  grant (`:144`) can. This is the documented "RLS on, no permissive policy"
  lockdown and it does NOT trip the spec-051/053 permissive-policy lint (no
  permissive policy is added). Correct.
- pgTAP coverage (`username_resolve_rate_limit.test.sql`, plan(7)) pins the
  budget boundary (1st/2..20/21st), per-IP isolation, the blank-IP shared
  bucket, RLS-blocks-authenticated, and anon-lacks-EXECUTE. Arms (6) and (7) are
  exactly the RLS/grant guards I would have asked for. Good.

Anti-oracle preservation — the load-bearing property of this whole spec — holds:
the limiter keys on client IP only, never the username (`:106-116`, RPC arg is
`p_ip`), and the function returns a generic `429 { error: "rate limited" }`
(`index.ts:107`) that is a per-IP "calling too often" signal, not a
per-username existence signal. The non-429 success path is unchanged: still
ALWAYS `200 { email: string | null }`. No new oracle. Correct.

The fail-open-on-error / fail-closed-on-clean-deny split (`index.ts:101-112`) is
the right tradeoff and is explicitly justified: an infra blip in the limiter RPC
must not become a login outage, but a clean `allowed === false` is honored. Note
the precise predicate `if (!rlErr && allowed === false)` only throttles on an
unambiguous deny — a null/undefined `allowed` (malformed RPC response) also
fails open. Defensible.

### Q3. Schema concerns (growth/cleanup, index, lock contention)

- **Table growth / cleanup — handled.** Composite PK `(ip, window_start)`
  (`:69`) means at most one row per IP per 60s window; the
  `prune_username_resolve_rate_limit()` RPC (`:148-166`) deletes rows older than
  1 hour, scheduled daily via pg_cron (`'17 4 * * *'`, `:185-189`) with the
  `if exists … unschedule` re-apply guard matching the convention. The daily
  cadence vs the 1-hour retention horizon means up to ~24h of dead rows can
  accumulate between prunes — but at this stack's traffic (a handful of
  restaurant staff/admins, not consumers) that is at most a few hundred rows.
  Negligible. See M1 for a minor note on the prune query plan.
- **Index on the IP+window key — present via the PK.** The PK
  `(ip, window_start)` IS the btree the ON CONFLICT upsert and the per-call
  lookup use. No separate index is needed and none is added — correct, no
  redundant index. (See M2: the prune's `where window_start < …` predicate does
  not have a leading-column index, but at this row count it is a trivial seq
  scan.)
- **Lock contention under concurrent login bursts — acceptable.** The ON
  CONFLICT DO UPDATE takes a row-level lock on the single `(ip, window_start)`
  row for the duration of the increment. Concurrent requests *from the same IP*
  in the same window serialize on that one row — which is exactly the desired
  semantics (you cannot race past a shared counter without serializing on it).
  Different IPs hit different rows → no contention. A burst from ONE IP (e.g. a
  whole restaurant behind one NAT — see M3) serializes, but the held-lock
  critical section is a single-row increment (microseconds), so even a
  same-IP burst will not meaningfully queue. No deadlock surface (single-row,
  single-statement, no multi-row ordering). Acceptable.

### Q4. Drift from the original spec 095 design contract — NONE; this CLOSES a flagged gap

The original Backend design (§API contract, mitigation (3)) explicitly called
for "a light per-IP rate limit" and noted Supabase edge has no built-in,
suggesting "a simple in-memory or Deno KV counter, or rely on GoTrue's rate
limit downstream." The original implementation shipped WITHOUT one — that was the
security-auditor's Medium-1. This migration closes that gap and, in doing so,
makes a BETTER choice than the design's own throwaway suggestion (in-memory /
KV), for the horizontal-isolate reason in Q1. The chosen budget (20 req/min/IP)
sits inside the design's stated "~10-30 req/min/IP" guidance. This is convergence
toward the design intent, not drift away from it. No contract was violated.

### Migration ordering / timestamp — CORRECT

`20260607130000` sorts strictly AFTER `20260607120000_profiles_username.sql`
(same day, +1 hour) and is the newest migration on disk (confirmed: the only
`2026-06-07` files are `…120000_profiles_username` and
`…130000_username_resolve_rate_limit`; prior neighbor is
`20260602120000_spec093_case_qty_backfill`). The limiter migration has no hard
dependency on the username column — it adds an independent table + RPCs — so even
the ordering is belt-and-suspenders rather than load-bearing, but it is correct.
The `db-migrations-applied` drift gate will flag both new local migrations until
`npx supabase db push --linked` runs in prod; the dev correctly listed this as a
manual deploy step (no new action beyond the existing push, plus a re-run of
`supabase functions deploy username-resolve` to ship the limiter call).

---

## Minor observations (advisory — no action required to ship)

### M1. Prune retention (1h) vs cron cadence (daily) leaves a benign 24h tail
`prune_username_resolve_rate_limit()` deletes rows older than 1 hour
(`:157-160`) but runs once daily (`:185-189`). So between prunes the table can
hold up to ~24h of windows, not ~1h. At this traffic that is a few hundred rows
at most — immaterial. If traffic ever grows, either run the prune hourly or note
that the 1h retention is aspirational vs the daily sweep. No action for v1.

### M2. Prune query has no index on `window_start`
The prune predicate `where window_start < now() - interval '1 hour'` (`:159`)
cannot use the PK btree (leading column is `ip`), so it is a seq scan. Correct
and trivial at this row count; flagging only so a future high-traffic spec knows
to add a `window_start` index (or a partial/BRIN) if this table ever grows. No
action.

### M3. Per-IP keying coarse-grains NAT'd locations (inherent, acceptable)
The limiter keys on client IP. A whole restaurant behind one NAT/public IP
shares one 20/min budget across all staff devices. For the login use case this
is fine (login attempts per location are low), but it is the standard per-IP
tradeoff and worth recording: under a shared-IP location, a legitimate burst of
several staff logging in within the same minute counts against one budget. 20/min
is comfortably above realistic concurrent-login load for a single location, so
this is acceptable. The alternative (keying on IP+something-finer) would
reintroduce per-username surface or require auth, neither of which fits a
pre-login endpoint. Inherent to the design, not a defect.

### M4. `service_role` table DML grant is redundant-by-design (already documented)
`grant select, insert, update … to service_role` (`:144`) is not strictly needed
— the SECURITY DEFINER RPC (running as owner) is the only writer, and the
function comment at `:141-143` says as much ("direct table grants are NOT
required … but grant DML for defense-in-depth parity"). Harmless; the RLS-on /
no-policy lockdown still blocks anon/authenticated regardless of this grant
because they are not `service_role`. Recording the intentional redundancy so a
future reviewer does not "tidy" it away thinking it widens exposure (it does
not — `service_role` already bypasses RLS).

---

## Summary

| # | Decision | Status |
|---|---|---|
| RL-1 | DB-backed shared counter vs in-memory/KV | CORRECT — endorsed |
| RL-2 | SECURITY DEFINER RPC + RLS-on/no-policy + service_role-only grant | MATCHES convention (`record_missed_orders_for_day`) |
| RL-3 | Atomic ON CONFLICT upsert (no race past the limit) | CORRECT |
| RL-4 | Anti-oracle preserved (IP-keyed 429, success path still always-200) | MATCHES — no new oracle |
| RL-5 | Fail-open on limiter error / honor clean deny | CORRECT tradeoff |
| RL-6 | Table growth handled (composite PK + 1h prune + daily cron) | ADEQUATE (M1 tail, benign) |
| RL-7 | Migration ordering 130000 after 120000 | CORRECT |
| RL-8 | Closes original-design mitigation (3) gap, budget in-guidance | CONVERGENCE, not drift |
| 1–8 | Original-design points (citext, anti-oracle resolver, backfill, get_pending_invitation, raw-fetch resolver, no-pub-change, LIKE-escape, reserved-list) | MATCHES (prior pass, unchanged) |

No Critical or Should-fix architectural drift. The rate-limiter fix is a sound,
convention-aligned closure of the security-auditor's Medium-1, and it does not
weaken the anti-oracle property. From the architecture seat this slice is ready
to ship pending the documented manual deploy steps (the two secrets +
`functions deploy username-resolve` + `db push`), which the developer correctly
flagged.
