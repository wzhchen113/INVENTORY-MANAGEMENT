## Test report for spec 121

### Acceptance criteria status

- AC1: `missed_eod` added to `public.notifications.type` CHECK via additive migration, all existing rows/types remain valid → **PASS** — `supabase/migrations/20260716000000_missed_eod_notification_type.sql` (Part 1, `drop constraint if exists` + re-add under the same name); exercised implicitly by every pgTAP arm that inserts a `missed_eod` row (`supabase/tests/missed_eod_notifications.test.sql::arm (1)`).

- AC2: **Detection** — for a scheduled `(store, vendor, business_date)` past its EOD deadline with no submitted `eod_submissions` row, exactly ONE `missed_eod` is emitted, deduped per `(store_id, business_date, vendor_id)` → **PARTIAL / NOT TESTED on the deadline-timing half.**
  - The emit-and-dedup *mechanics* (one row per `(store,date,vendor)`, re-run is a no-op, different vendor gets a separate row) are **PASS** — `supabase/tests/missed_eod_notifications.test.sql::arm (1)`, `arm (3)`, `arm (4)`. These call `public.emit_missed_count(...)` directly with explicit args.
  - The *decision of whether a given (store, vendor) is currently past its deadline* — i.e., whether the cron's Track 3 pass should call the emitter at all — lives entirely in the TS-only `minutesSinceDeadline` helper in `supabase/functions/eod-reminder-cron/index.ts:65-74`. This has **zero** automated coverage in any of the three tracks (pgTAP can't reach a Deno-local TS function with no SQL surface; jest doesn't load Deno edge functions; no shell smoke exercises the cron). See the dedicated finding below — this is the one the architect flagged Critical.

- AC3: **Deterministic dedup key** — `source_id` = `md5(store_id||'|'||business_date||'|'||vendor_id)::uuid`, combined with the `(type, source_id)` unique index + `on conflict do nothing` → **PASS** — `supabase/tests/missed_eod_notifications.test.sql::arm (1)` (derivation matches), `arm (3)` (re-emit no-ops).

- AC4: **Brand scoping is inherited, not re-implemented** — same `privileged_brand_read_notifications` RLS policy as spec 120; brand-A admin sees zero brand-B misses; super_admin sees all → **PASS** — `supabase/tests/missed_eod_notifications.test.sql::arm (5)` (brand-A admin sees own), `arm (6)` (brand-A admin denied brand-B), `arm (7)` (super_admin sees both). No new policy was added (migration review confirms — only the CHECK constraint and the new function are DDL).

- AC5: **Bell visual — red dot on the missed row** — `missed_eod` row dot renders `C.danger`, submission rows unchanged (`C.accent`) → **PASS** — `src/components/cmd/NotificationBell.test.tsx::rowDotColor` (3 tests: danger for unread miss, accent for unread submission, transparent once read).

- AC6: **Bell visual — red badge on any unread miss** — badge is `C.danger` iff ≥1 unread `missed_eod`, else `C.accent`; zero unread → no badge (unchanged) → **PASS** — `src/components/cmd/NotificationBell.test.tsx::badge color fork` (2 tests) + `feedHasUnreadMissed` (4 tests covering true/false/empty-feed cases). The "zero unread → no badge" half is unchanged pre-existing behavior (`unread > 0` gate at `NotificationBell.tsx:110`), not independently re-tested here but not touched by this spec either.

- AC7: **Row label** — `missed_eod` reads "Missed EOD count · <store>" via new i18n key `chrome.submissionBell.type.missed_eod` in en/es/zh-CN → **NOT TESTED (low risk).** The i18n key exists and passes locale-parity (`npx jest i18n.test` — 24/24 pass, confirming the key is present and structurally identical across all three locale files). The *rendered composition* (`typeLabel(n.type) + ' · ' + storeName`) is unchanged spec-120 code, and `NotificationBell.test.tsx` deliberately tests only the extracted pure color-derivation helpers, not full component render output (documented boundary reason in the test file: importing the full component drags in `useStore`/`supabase.ts`, which crashes under jest with no Supabase env — same boundary as the pre-existing `StatusPill` test). No automated test asserts the string "Missed EOD count · Downtown" is what actually renders. Low risk because the concatenation logic itself is untouched, proven spec-120 code; only the key's *value* is new.

- AC8: **Push** — `missed_eod` pushes to the same recipients as a submission, with miss-specific copy ("Missed EOD count" / "<store> · <vendor>"), `actor_user_id` NULL excludes no one → **NOT TESTED (pre-existing gap, not a regression).** No smoke script (`smoke-edge.sh`, `smoke-rpc.sh`, `smoke-edge-roles.sh`) exercises `submission-push-fanout` at all, for either spec 120 or spec 121 — this gap predates this spec. Manual code review of `supabase/functions/submission-push-fanout/index.ts:21-28,150-160` confirms the `TYPE_LABEL` entry and the `isMiss` title/body branch match the spec's §6 design exactly (title never reads "... submitted" for a miss; body reads `store · vendor` via the `actor_name` slot-reuse). Recipient resolution (brand admins + supers, minus `actor_user_id`) is unchanged code, already covered structurally by spec-120's own (equally absent) push testing posture.

- AC9: **Future brands + stores work automatically** — detection scopes purely by `stores.brand_id`, no hardcoded brand/store list → **PASS** — `supabase/tests/missed_eod_notifications.test.sql::arm (7)` uses a test-only foreign brand/store (`brand_b`/`store_b`, not seeded, inserted fresh in the test fixture) and confirms it routes correctly through the generic `auth_can_see_brand()` policy with zero brand-specific code — this is precisely the "new brand routes automatically" property.

- AC10: **No realtime publication change** → **PASS** — confirmed by migration review: `supabase/migrations/20260716000000_missed_eod_notification_type.sql` contains only the CHECK-constraint DDL and the new function/revoke; no `alter publication` statement. No `docker restart supabase_realtime_imr-inventory` was performed or needed, consistent with the spec's explicit call-out.

### Test run

**pgTAP** — `bash scripts/test-db.sh`
- `supabase/tests/missed_eod_notifications.test.sql` → **PASS, 7/7 assertions.**
- Full suite: 68 test files, **67 pass / 1 fail.**
- The 1 failure is `supabase/tests/item_vendors_rls.test.sql`, arm 12 ("non-member UPDATE cannot write order_code on a Charles link — stays NULL"), a pre-existing failure unrelated to spec 121. Confirmed via `git log`: this test file was last touched in the spec-114 commit (`806c6d9`, "Per-vendor order codes + universal quick-order list export"), well before this spec's changes. Not a regression introduced here — flagged separately, not blocking spec 121.

**jest**
- `npx jest NotificationBell` → **PASS, 9/9** (`feedHasUnreadMissed` ×4, badge color fork ×2, `rowDotColor` ×3).
- `npx jest i18n.test` → **PASS, 24/24** (both `src/i18n/i18n.test.ts` and `src/screens/staff/i18n/i18n.test.ts` — confirms `missed_eod` key parity across en/es/zh-CN).
- Full suite `npx jest` → **PASS, 103 suites / 1193 tests** (matches the frontend-developer's reported count exactly). Some pre-existing `act(...)` warnings from `src/screens/staff/screens/EODCount.tsx` in console output — cosmetic noise, unrelated to this spec, not new failures.

**typecheck**
- `npx tsc --noEmit` → clean, no errors.

**shell smoke**
- Not run against this spec's surface — no smoke script exercises `eod-reminder-cron` or `submission-push-fanout` (pre-existing gap for both spec 120 and 121; see AC8 above).

### Notes — the key gap (rollover helper), and BLOCK determination

**This is the one finding that matters most in this review.** `minutesSinceDeadline` (`supabase/functions/eod-reminder-cron/index.ts:65-74`) is the sole gate deciding whether Track 3 calls `emit_missed_count` for a given `(store, vendor)` on a given cron tick. It has to correctly handle the 3 AM business-day rollover: a 22:00 deadline checked at 00:30 local (same business date, past midnight) must read as "passed," which requires the `+1440` shift on both `nowMin` and `cutMin` when the respective hour is `< 3`.

I traced the arithmetic by hand for the boundary cases:
- 21:00 (before deadline): `nowMin=1260`, `cutMin=1320` → `minutesAfter=-60` → correctly NOT passed.
- 22:00 (at deadline): `minutesAfter=0` → correctly passed (`>= 0` threshold).
- 00:30 (post-midnight, same business date): `nowMin=30+1440=1470`, `cutMin=1320` (unshifted, since deadline hour 22 is not `< 3`) → `minutesAfter=150` → correctly passed. This is exactly the case that `minutesUntilCutoff` (Track 1/2's helper) would get wrong (it would report "+1290 minutes until," i.e. never "passed").
- 02:59 (last minute before rollover): `minutesAfter=299` → correctly still counted as a miss.
- 03:00 (rollover instant): business date advances (via `businessTodayInTZ`'s identical shift), and `nowMin` no longer gets the `+1440` shift (hour 3 is not `< 3`) → `minutesAfter=-1140` → correctly NOT passed, because we're now evaluating the **new** business date's not-yet-arrived 22:00 deadline. This is expected, not a bug — it's what enforces forward-only detection.

My manual trace did not find a bug — the logic reads correct for the boundary cases I checked. **But a hand-trace during code review is not a regression-proof test.** This is a hand-rolled timezone/rollover arithmetic helper — exactly the class of code most prone to silent off-by-one or sign errors, and exactly the class of bug the architect called out as "silently never fires" (a false negative that produces no error, no crash, no failed test — the miss simply never appears, which is invisible until someone notices a store's misses aren't showing up). It sits on the *detection* acceptance criterion (AC2), which is the core of this spec's user story ("impossible to overlook").

**Verdict: this AC is genuinely uncovered and HIGH RISK. I am flagging AC2 (Detection) as NOT TESTED on its timing half, and recommending this BLOCKS full sign-off** until the gap is closed — not because I found a bug, but because there is no regression net for a bug class this project has explicitly identified as its own Critical risk, on code that will run unattended every 5 minutes in production.

**Recommended fix path** (mirrors the project's own established precedent): mirror `minutesSinceDeadline` (and its `wallPartsInTZ`/`businessTodayInTZ` dependencies, or a minimal reimplementation taking already-computed wall/cutoff parts) into `src/utils/` — the same "TS mirror exists exclusively for jest coverage, not imported by the edge function" pattern already used for `src/utils/escapeHtml.ts` (CLAUDE.md, spec 027 precedent). Then add a jest test asserting the rollover across the day boundary: before-deadline (negative), at-deadline (zero, boundary), post-midnight-same-business-date (positive, the case that a naive `minutesUntilCutoff`-style reuse would get wrong), and the 03:00 rollover instant (negative again, new business date). This closes the gap with the same identity-enforced-at-code-review-time posture the project already accepts for `escapeHtml`.

This is a **process gap, not a functional bug** — I found no evidence the helper is currently wrong. But per this project's own stated risk model (a "silently never fires" bug class the architect flagged Critical, on unattended production code), shipping it with zero regression coverage is the finding I'm required to surface.

### Other notes

- The pgTAP file's own header comment (`supabase/tests/missed_eod_notifications.test.sql:20-26`) already self-documents this exact gap and defers it to "the jest/frontend track via the escapeHtml src/utils-mirror pattern" — i.e., the backend-developer flagged the same gap I'm confirming here, but the mirror + jest test were never actually added. The intent was recorded; the artifact wasn't built.
- AC7 (row label) and AC8 (push) are NOT TESTED but assessed LOW risk — both are thin, already-proven spec-120 code paths (string concatenation, recipient resolution) with only a new key/branch value added, and AC8's testing gap is a pre-existing project-wide posture (no spec-120 push smoke either), not a regression this spec introduced. I am not blocking on these two.
- No test framework drift: all new tests landed in the existing pgTAP (`supabase/tests/`) and jest tracks. No vitest/playwright/new framework introduced.
- `app.json` slug untouched, consistent with the spec's explicit note.
