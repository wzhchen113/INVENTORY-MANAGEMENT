# Backend-architect drift review — spec 121 (missed EOD count alerts)

Post-implementation review of the STAGED implementation against the `## Backend
design` I authored in `specs/121-missed-eod-count-alerts.md`. Verdict: **no
Critical drift. Implementation matches the contract.** One Should-fix (my own
flagged Critical path ships with zero automated coverage — disposition decided
below) and two Minor confirmations.

Files reviewed:
- `supabase/migrations/20260716000000_missed_eod_notification_type.sql`
- `supabase/functions/eod-reminder-cron/index.ts` (Track 3 + `minutesSinceDeadline`)
- `supabase/functions/submission-push-fanout/index.ts` (missed_eod branch)
- `supabase/tests/missed_eod_notifications.test.sql`
- `src/components/cmd/NotificationBell.tsx` (4 exported color helpers)
- cross-refs: `20260715000000_submission_notifications.sql`, `20260618000000_public_grants_explicit.sql`

---

## 1. Migration — MATCHES design (§1, §3, §4)

- **CHECK widened correctly.** `notifications_type_check` dropped defensively
  (`drop constraint if exists`) and re-added under the same name with
  `'missed_eod'` appended to the legacy five values (migration lines 22–27).
  Additive; all existing rows stay valid. No new table, no new column, no new
  index. No `alter publication` — correct, `notifications` was already published
  at `20260715000000` Part 7, so **no `docker restart` ritual** for this
  migration (as designed §1/§8).
- **Version `20260716000000`** sorts strictly after the spec-120
  `20260715000000` (glob-confirmed the two are adjacent) — no collision, correct
  dependency order (references `notifications`, `enqueue_submission_push`, and
  the `(type, source_id)` index from the prior migration).
- **`emit_missed_count` matches §4 byte-for-intent:** `SECURITY DEFINER` +
  `set search_path = public` (lines 57–58); deterministic
  `md5(store||'|'||date||'|'||vendor)::uuid` source_id (lines 73–75); vendor name
  → `actor_name` display slot with `actor_user_id = null` (line 79);
  storeless/brandless early-return (line 69); exception-safe inner
  `begin/exception when others → raise warning` so a miss failure never breaks
  the cron run (lines 66/86–89); `on conflict (type, source_id) do nothing
  returning id` gating the push (lines 80–85); `revoke execute ... from public,
  anon, authenticated` (lines 92–93). Mirrors the spec-120 emitter shape exactly.

**Service-role EXECUTE — verified, no permission bug.** The cron calls
`emit_missed_count` via `rpc()` on a **service_role** client
(`eod-reminder-cron` line 168), NOT from inside a SECURITY DEFINER trigger like
the spec-120 emitter. The `revoke ... from public, anon, authenticated` leaves
service_role's grant intact because spec-097's
`20260618000000_public_grants_explicit.sql:205-206` (`alter default privileges
... grant all on functions to ... service_role`) grants EXECUTE to service_role
on every future postgres-owned function at creation. So the design's "service_role
retains execute" claim holds — and it holds for the *right structural reason*
(the ADP grant), not merely "revoke-from-public spares service_role." Track 3's
`sb.rpc('emit_missed_count', …)` will execute, not 42501.

---

## 2. Track 3 + `minutesSinceDeadline` — CORRECT across the day boundary

Traced the `+1440` rollover helper (`eod-reminder-cron` lines 65–74) against the
Critical I flagged. Deadline `22:00` → `cutMin = 1320` (hour 22, not `< 3`, no
shift):

| wall clock | nowMin | minutesAfter | fires? | correct |
|-----------|--------|-------------|--------|---------|
| 21:00 (pre-deadline) | 1260 | −60 | no (`< 0` continue, line 366) | ✓ |
| 22:30 | 1350 | +30 | yes | ✓ |
| 00:30 (post-midnight) | 30 **+1440**=1470 | +150 | yes | ✓ — the bug-class case |
| 02:59 | 179+1440=1619 | +299 | yes | ✓ |
| 03:00+ | biz date rolls forward (now−3h) → prior day no longer in the weekday schedule query | — | forward-only holds | ✓ |

Also correct for a hypothetical post-midnight deadline (e.g. `01:00`, `ch < 3` →
`cutMin` also `+1440`), so the normalization is symmetric. Track 3 fires ONLY
after the deadline (`minutesAfter < 0 → continue`, line 366) and dedups on the
submitted-set + `emit_missed_count`'s `(type, source_id)` conflict (lines
356–367). The batched `eod_submissions` read filters `status='submitted'` so a
`draft` row is still a miss (line 357). Cron uses `minutesSinceDeadline`, NOT the
after-midnight-broken `minutesUntilCutoff` — the exact substitution the Critical
demanded. **The load-bearing normalization is present and correct.**

---

## 3. Post-midnight test disposition — MY CALL: mirror it (Should-fix)

The pgTAP file correctly documents (lines 20–26) that the post-midnight
`minutesSinceDeadline` case CANNOT be pgTAP'd — it's a TS-only helper with no SQL
surface — and defers coverage to the jest track "via the escapeHtml src/utils
mirror pattern." The frontend dev did not place that mirror; grep confirms **no
`src/utils/minutesSinceDeadline*` exists and no jest test references the helper.**
So my flagged Critical path currently ships with **zero automated coverage.**

**Decision (explicit, because this was my Critical): MIRROR IT. Should-fix, not
Critical.**

- **Not Critical** — the code is verified-correct by the trace in §2; nothing
  ships broken.
- **Not accept-uncovered** — I considered it and rejected it. The failure mode of
  a regression here is *silent*: a broken normalization emits zero rows with no
  exception, no log error, no red test — which defeats the entire "impossible to
  overlook" owner intent with no signal. That is precisely the profile that
  warrants a pinned regression test, and the `+1440` shift is a single
  easy-to-"simplify"-away line.
- **The precedent exists and the codebase already pays its cost.** CLAUDE.md's
  escapeHtml rule is this exact Deno/jest boundary: a TS mirror under `src/utils`
  that exists *exclusively* for jest coverage, with Deno↔mirror identity enforced
  at code-review time. `minutesSinceDeadline` is a clean fit.
- **Feasible without signature churn.** `wallPartsInTZ` reads `at ?? new Date()`
  and `businessTodayInTZ` reads `Date.now()`; both respond to
  `jest.useFakeTimers().setSystemTime(...)`. A mirror `src/utils/minutesSinceDeadline.ts`
  (verbatim copy of lines 65–74 + the two TZ helpers it needs) plus a jest test
  asserting: 22:00 deadline read at a fixed instant that is 00:30 America/New_York
  → `minutesAfter >= 0`; and 21:00-local → `minutesAfter < 0`. Byte-identity with
  the Deno copy checked at review, same as escapeHtml.

This is the one piece of the design not yet satisfied. It is a follow-up, not a
build-blocker for the correctness of the shipped code.

---

## 4. Parameter-order discrepancy — §4 is authoritative; all three sites agree

The dev flagged §4's signature `(store, vendor, vendor_name, business_date)` vs a
`(store, business_date, vendor, vendor_name)` ordering that appears inline
elsewhere in the spec prose. **§4 is authoritative** (it is the "Emitter" design
section that defines the function contract). Confirmed all three code sites follow
§4, and the call site can't even drift because it's keyword-bound:

- **Migration** definition: `(p_store_id uuid, p_vendor_id uuid, p_vendor_name
  text, p_business_date date)` — lines 50–55. = §4. ✓
- **Cron call site** uses **named** params (`p_store_id / p_vendor_id /
  p_vendor_name / p_business_date`, `eod-reminder-cron` lines 369–374) — order
  cannot desync regardless of prose. ✓
- **pgTAP** uses **positional** args `(store_a, vendor_1, 'Coca-Cola (test)',
  bizdate)` (`missed_eod_notifications.test.sql` lines 74–79) = (store, vendor,
  name, date) = §4. ✓ This is the one site where a mismatch would surface as a
  wrong-type error, and it matches.

No drift. The prose inconsistency the dev noticed has no code consequence.

---

## 5. Push — MATCHES §6; recipients unchanged

`submission-push-fanout` edits are exactly the two designed: `TYPE_LABEL` adds
`missed_eod: 'Missed EOD count'` (line 28); the `isMiss` copy branch (lines
154–159) forks title to `'Missed EOD count'` and body to `store · vendor`
(reading `actor_name` as the vendor per §4 slot reuse) vs the submission
`vendor·store`/`"${label} submitted"` copy. **Recipient resolution is
byte-unchanged** (lines 121–133): all `super_admin` + `admin`/`master` of
`notif.brand_id`, minus `actor_user_id`; with `actor_user_id = NULL` the
`if (notif.actor_user_id)` guard is falsy so no one is excluded — correct, a miss
has no submitter to drop. No `verify_jwt`/config change, shared-bearer gate
untouched.

---

## 6. Bell — MATCHES §10; accent/danger fork preserved

Four pure helpers extracted and exported for jest (`NotificationBell.tsx` lines
42–64), preserving the §10 fork exactly:
- `feedHasUnreadMissed` → red is reserved for an unread `missed_eod`.
- `badgeBackgroundColor` → `danger` iff `hasUnreadMissed` else `accent`
  (recolors the routine spec-120 badge off red — owner Q1).
- `badgeTextColor` → `#FFFFFF` on the danger badge, `C.accentFg` on the accent
  badge (legible in both palettes).
- `rowDotColor` → `transparent` when read; `danger` for a `missed_eod` row;
  `accent` otherwise.

Wired into the component via the `hasUnreadMissed` memo (lines 77–80) and the
badge/dot render (lines 117, 129, 232). Badge still shows total unread count
(`unread`), only its color forks — as designed. **No store-slice change, no db.ts
helper** (grep-consistent with §7/§9 — the type union add in `src/types/index.ts`
is the only frontend data-shape touch, and `mapNotification` passes `type`
through). Row-highlight background stays `accentBg` for any unread row (the design
only reddened the DOT) — correct, not drift.

---

## 7. Prod deploy state (pending main Claude — flag, do not action)

Nothing below is applied to prod yet; all three are required for the feature to
function live:

1. **Migration apply via MCP** — `db push` lacks the prod password
   (MEMORY.md). Apply `20260716000000_missed_eod_notification_type.sql` via
   `execute_sql`, then insert version `20260716000000` into
   `supabase_migrations.schema_migrations` so the `db-migrations-applied` gate
   stays green (else it hard-fails repo-vs-prod, per CLAUDE.md CI note). Verify
   `emit_missed_count` via normalized-md5 after apply.
2. **Redeploy `eod-reminder-cron`** — Track 3 + `minutesSinceDeadline` are
   inert until deployed; without it NO misses are ever detected.
3. **Redeploy `submission-push-fanout`** — the `missed_eod` copy branch; without
   it a miss push would fall through to `TYPE_LABEL[...] ?? 'Submission'` and the
   old "submitted" phrasing on the redeployed function's absence.

No realtime restart is needed (no publication change).

---

## Minor / carry-forward (from the design, still standing — not new drift)

- **Badge-vs-feed window skew (design Should-fix, unchanged).** `hasUnreadMissed`
  derives from the ≤50-row/30-day feed while `submissionUnreadCount` comes from
  the RPC over the full window. Misses are low-volume and the feed is
  newest-first, so a recent miss is in-window; acceptable for v1 as designed. The
  `unread_missed_notification_count()` RPC escape hatch remains the growth
  mitigation. Not blocking.
- **5-hour no-op window cost (Minor).** Each 5-min run in 22:00→02:59 issues one
  `emit_missed_count` per still-missed `(store, vendor)`; all but the first are
  `on conflict do nothing` no-ops, one batched `eod_submissions` read per run.
  Negligible on the seed. As designed.

---

## Summary

| Sev | Finding |
|-----|---------|
| Should-fix | `minutesSinceDeadline` (my flagged Critical path) has zero automated coverage. **Disposition: mirror to `src/utils/minutesSinceDeadline.ts` + jest rollover test** (escapeHtml precedent). Code is verified-correct by inspection, so Should-fix not Critical — but a silent-no-fire regression class warrants the pin. |
| Minor | Badge-vs-feed window skew — stands as designed, acceptable v1. |
| Minor | 5-min no-op window cost — stands as designed, negligible. |

Migration, emitter, Track 3 rollover, parameter order (§4 authoritative, all
three sites agree), push branch, recipient set, and the four bell color helpers
all match the design with no Critical drift.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 1 Should-fix (mirror
  `minutesSinceDeadline` to `src/utils` with a jest rollover test — the flagged
  post-midnight Critical path is verified-correct but unpinned), 2 Minor (both
  stand as designed). No Critical drift; migration/cron/push/bell all match the
  contract. Prod migration apply + both edge redeploys (eod-reminder-cron,
  submission-push-fanout) pending main Claude.
payload_paths:
  - specs/121-missed-eod-count-alerts/reviews/backend-architect.md
