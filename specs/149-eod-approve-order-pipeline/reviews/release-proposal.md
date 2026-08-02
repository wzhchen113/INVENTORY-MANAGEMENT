# Release proposal — spec 149 (EOD → Approve & Order pipeline, phone)

Synthesized 2026-08-02 from the four reviewer files in this directory, the spec
body (including both "Review fix round" sections), and spot-checks of the staged
tree.

## Verdict

verdict: SHIP_READY
rationale: No reviewer holds an open Critical — the one Critical-severity finding
(test-engineer's untested AC-7) and every Should-fix/Medium that was in scope were
closed in the two fix rounds and verified in the staged tree; the remaining items
are PM decision gates that block *Instacart channel enablement*, not merge, and
the code ships dark behind four independent gates.

**Both hard rules checked explicitly:**

1. *No SHIP_READY with an open Critical.* Zero Criticals remain open. The only one
   ever raised — AC-7 push copy with zero coverage in any track — is now covered by
   `derivePushCopy()` extracted in `supabase/functions/submission-push-fanout/index.ts:74`
   and byte-mirrored at `src/utils/pushNotificationCopy.ts` (the documented
   `escapeHtml` mirror pattern), with 9 jest pins. Verified present in the staged tree.
2. *No SHIP_READY while either CI gate is red on `main`.* Both `test.yml` and
   `db-migrations-applied.yml` are currently green on `main` from the specs-143-148
   push. This changeset is uncommitted, so the gates must be re-confirmed after the
   push — and `db-migrations-applied.yml` **will go red between push and prod-apply**,
   which is expected, documented in §10.5, and closed out by step 5 of the
   operational sequence below. That interval is a known deploy window, not a red
   gate at decision time.

## Findings summary

**code-reviewer** — 0 Critical, 1 Should-fix (**resolved**), 4 Nits (open, advisory).
- Should-fix: `PhoneApproveOrder.openInNewContext` called `Linking.openURL` with no
  `.catch` while its near-duplicate in `useStore` reported correctly. Resolved by the
  extraction option: both sites now delegate to `src/utils/openExternalUrl.ts` with
  `notifyBackendError` passed in as the reporter. Verified in the staged file.
- Explicitly verified clean by the reviewer: AC-REG freezes byte-for-byte
  (`LineStepper`/`VendorOrderCard` exported with an additive defaulted `footer` prop;
  `NotificationBell.tsx` zero-diff), no `connect.instacart.com` or key material under
  `src/`, `supabase.functions.invoke` (documented exception) not bare `fetch`,
  additive migrations, load-bearing `auth_is_privileged()` on all three policies.
- Nits (all out of scope / non-blocking): silent 0-row `advanceOrderApproval` update,
  pre-existing `fetchBreadbotSales` dead branch, no store-edit surface for postal code
  (= architect S-4), 260-line single edge-function handler.

**security-auditor** — 0 Critical, 0 High, 2 Medium (**both resolved**), 5 Low (open, advisory).
- Medium 1 (no scheme allowlist on operator-editable URLs — `vendors.order_page_url`,
  `order_approvals.external_ref`): resolved by the shared `openExternalUrl` gating on
  `/^https?:\/\/\S/i` after `trim()`, refusing with a toast and returning `false`; the
  webstaurant branch now **refuses instead of half-approving**. 27 jest cases plus a
  store-level `javascript:` arm. Verified in `src/utils/openExternalUrl.ts:40-71`.
- Medium 2 (server-resolved channel client-overwritable while `pending`, edge function
  trusting the stored value): resolved in `tg_order_approvals_guard()` — a pending-row
  `channel` change is legal only downward (`extension`/`manual`) or equal to
  `public.vendor_order_channel(new.vendor_id)`. Both forms were implemented on purpose,
  because pure-downward alone would permanently wedge a row (no DELETE policy). Pinned
  by pgTAP (G7) refusal, (G8) downward, (G9) anti-wedge — all three present in
  `supabase/tests/order_approvals.test.sql`.
- Lows (open, none blocking): no brand/submission provenance cross-check in
  `create_order_approval`; raw PostgREST error text rendered in-screen; `notifications`
  is brand-scoped not store-scoped (inherited from spec 120, marginally widened by the
  vendor name in `body`); no ZIP format validation (no injection — `encodeURIComponent`'d,
  base URL env-only); no per-caller rate limit on the edge function.
- Also verified clean by the auditor: `verify_jwt = true` pinned with rationale, inline
  `ADMIN_ROLES` + `requireAdminCaller()` mirroring `delete-user`, no `service_role`
  client anywhere in the request path (RLS is the cross-store gate), secret never
  logged or echoed, upstream 502/504 mapping with no fake success, `permissive_policy_lint`
  green with no allowlist row, double input validation (RPC 22023 + edge 400).

**test-engineer** — 30/30 acceptance criteria PASS after the fix round; 1 Critical
(**resolved**), 2 Should-fix (**both resolved**), 3 carry-forward notes.
- Every gate was independently **re-executed**, not taken on the developers' word,
  including live HTTP against the deployed local edge function (non-privileged JWT →
  403, cross-store `approvalId` → 404 before any upstream contact, wrong-channel → 409
  with correlationId and no secret leak) and a real `create_order_approval` RPC round trip.
- Critical: AC-7 was the sole untested criterion (a pre-existing infra gap — the
  spec-121 `isMiss` and spec-126 `isIssue` branches had never been covered either).
  Resolved via the mirror pattern above, which incidentally closes those two legacy
  branches as well. A shell smoke was correctly rejected as dishonest here (the copy
  travels inside an encrypted web-push payload; no HTTP assertion can observe it), and
  a Deno harness was correctly rejected as a fourth framework.
- Should-fix 2 (untested vendor/store config UI) → `VendorFormDrawer.test.tsx` gained a
  7-case block; `StoreFormDrawer.test.tsx` is new. Should-fix 3 (untested `db.ts`
  mappers) → `db.orderApprovalMappers.spec149.test.ts` is new.
- AC-12 is PASS by reuse-transitivity (components exported, not forked) rather than a
  fresh a11y assertion — flagged as inherited, accepted.
- AC-30 is manual and not wired into CI; the live local run covered preflight/401/403/404,
  with the mint and forced-502 arms legitimately skipped for want of an IDP key.
- Carry-forward notes 4/5/6 (retailer pinning, prod migration state, CI-after-push) are
  reflected in the decision gates and operational sequence below.

**backend-architect** (post-impl drift) — 0 Critical, 4 Should-fix (**S-2 and S-3
resolved; S-1 and S-4 are decision gates by the architect's own explicit
classification**), 7 Minor (open, advisory).
- S-2: the design's `eod_entries` LEFT JOIN was inert on every real path (AFTER INSERT
  fires before entries land), so §3.3's "never a false positive" was wrong — the
  predicate approximates in **both** directions off pre-count `current_stock`. The join
  is **dropped** (zero behavior change, decoy removed — verified in
  `20260801000200:100-127`) and the wording corrected in §3.3, §1.3, §10 risks 3/8,
  deviation 5, both `comment on` strings, and the pgTAP header. No async job, per the
  architect's ruling: the false positive requires an unrecorded receipt and is contained
  by AC-13's empty state. This was a defect in the *design* (R-2), not implementation drift.
- S-3: `create_order_approval`'s select-then-insert race now has an
  `exception when unique_violation` handler that re-reads the winner and falls through
  the same R-6/retry logic, re-raising if the re-read finds nothing. Pinned by pgTAP
  (C7), which reproduces the lost-race window hermetically via a self-disarming
  test-only RESTRICTIVE policy. Verified at `20260801000100:408`.
- S-1 / S-4: PM decision gates — see below. The architect states the classification
  explicitly: "**not a code Critical** and must not block SHIP_READY of the
  dark-launched code."
- Endorsed as correct, not drift: the trigger-body exception envelope (M-5) and the
  arm-(5a/5b) pgTAP split (which also restored meaning to the previously-vacuous
  dedupe arm 10). R-1, R-3, R-5, R-6, §2 RLS, AC-20 guard, AC-22/23/24 posture and the
  spec-104 per-each ★ bridge all landed as designed; the caller-token-only request path
  is called "the strongest part of the implementation."
- Minors open and advisory: M-1 (§5.3 error table missing `not_configured` /
  `writeback_failed` / `unexpected_error`), M-2 (stale-JWT asymmetry makes a
  freshly-promoted admin see a misleading 404), M-4 (a pgTAP arm overstates its RLS
  coverage), M-7 (a client-side transition precondition is server-enforced only).
  M-3 evaporated with S-2's dropped join. M-6 no action.

**Fix-round gates (re-run by the fix agents, numbers consistent across both rounds):**
pgTAP 79/79 (`order_approvals` 20 → 24 arms), jest 182 suites / 1809 tests,
`tsc --noEmit` clean, `typecheck:test` clean, `npx expo export --platform web`
succeeds, extension vitest 31/31 with `extension/` at zero diff.

## Decision gates (PM — not code blockers, but they gate the Instacart channel)

- **DG-1 — Instacart retailer pinning does not exist in the live IDP API (architect
  S-1, test-engineer note 4).** `products_link` has no `retailer_key`/`retailer_id`
  parameter as of the 2026-08-01 doc check, so a minted link lands on a shopping-list
  page where the admin picks the store — the *items* are pre-filled, the *retailer* is
  not. This contradicts the PM summary's "opens an Instacart cart that is already
  filled." **Blocks Instacart channel enablement, not merge.** Accepting it costs
  three things that should land *with* the acceptance, not after: (a) one added
  disclosure i18n string in all three catalogs saying the store is chosen on Instacart
  (AC-10's honesty bar); (b) demoting the §5.5 retailer probe from a blocking 409 to an
  advisory "is Instacart in this market at all" check — keeping both a retailer-key gate
  and an unpinned link is incoherent and saves an upstream round trip; (c) recording in
  the spec body that `instacart_retailer_key` is advisory metadata, not a pinning
  mechanism. The STOP condition §5.4 armed fired and was escalated rather than worked
  around — that is the correct behavior and should be read as such.
- **DG-2 — `stores.postal_code` has no edit surface for existing stores (architect S-4,
  code-reviewer nit 3, frontend deviation 2).** `StoreFormDrawer` is create-only, so
  today no existing store can get a ZIP through the UI, and the edge function
  short-circuits on a null ZIP. For the dark launch this is *helpful* (it is gate 3 of
  four), but Instacart enablement needs either a store EDIT drawer (follow-up spec) or a
  one-off write. `db.updateStore` already accepts `postalCode`, so the write path is ready.
- **DG-3 — `INSTACART_IDP_API_KEY` is unset.** The function returns
  `500 not_configured` without it. Not needed for a dark ship; required before the
  channel works.
- **Behavior heads-up (shipped default, not a gate):** OQ-1 resolved as *replace* (R-1),
  so for a vendor with below-par linked items the admin now gets **`order_ready`
  instead of** the routine spec-120 `eod` FYI. One ping per submission either way, by
  design (AC-3) — but it is a visible change to a shipped notification, worth watching
  for a night.

**Dark-launch containment is verified, independently, by the architect against the
staged code:** four gates stand between prod today and a minted link —
`vendors.order_channel = 'instacart'` explicitly set (default NULL ⇒ R-3 resolves to
`extension`/`manual`), a non-blank `instacart_retailer_key`, a non-null
`stores.postal_code` (currently unopenable through the UI, per DG-2), and the live
retailers probe. BJ's / Sam's continue to resolve to the tuned cart-filler. On-ship
behavior is byte-identical to today.

## Recommended next steps (ordered)

1. **Commit the staged tree** (user runs the commit — nothing is committed yet). Message
   should name spec 149 plus both fix rounds.
2. **Push to `main`**, then confirm the `test.yml` run for that commit is green:
   `gh run list --branch main --workflow test.yml --limit 1`.
3. **Let the Vercel web build for that commit go live before step 5.** Sequencing
   matters in one direction only: migration `…000200` starts emitting `order_ready`
   rows the moment it lands, and the client that renders the row copy + deep link is the
   one in this commit. Client first, then the emitter.
4. **Deploy the two edge functions:** `instacart-cart-link` (new,
   `verify_jwt = true` per `config.toml`) and `submission-push-fanout` (modified —
   without this deploy the new push copy never reaches a device, which is exactly the
   AC-7 surface).
5. **Apply the three prod migrations via the Supabase MCP `execute_sql` path**
   (`db push` lacks the prod password), in strict dependency order —
   `20260801000000_vendor_order_channel` → `20260801000100_order_approvals` →
   `20260801000200_order_ready_notification_type` — inserting each exact version into
   `supabase_migrations.schema_migrations` and verifying function bodies with the
   normalized-md5 check. Out-of-order application fails loudly ("function does not
   exist"), so there is no silent half-state.
6. **Re-confirm `db-migrations-applied.yml` is green**
   (`gh run list --branch main --workflow db-migrations-applied.yml --limit 1`; re-run
   the workflow if the last run predates the prod apply). Between step 2 and step 5 this
   gate is **expected red** — flag it, do not "fix" it. Do not treat the ship as complete
   until it re-greens.
7. **No realtime restart.** R-5 verified against the actual migration bodies: zero
   `alter publication` statements, `order_approvals` deliberately unpublished. Do not
   pad the checklist with `docker restart supabase_realtime_imr-inventory`.
8. **Human smoke on a phone-width viewport (<768px), both themes.** Neither fix round
   had browser tooling; the compensating evidence is a successful `expo export` plus
   testing-library renders. Walk: staff EOD submit → bell shows an accent (not red)
   `order_ready` row → tap → Approve Order screen → stepper → APPROVE & ORDER on an
   `extension` vendor (the live path) → MARK ORDERED.
9. **Confirm the Instacart channel is still dark in prod** — no vendor with
   `order_channel = 'instacart'` and a non-blank `instacart_retailer_key`. This is the
   assumption the SHIP_READY verdict rests on.
10. Then hand DG-1 / DG-2 back to the PM before anyone opens gate 1.

## Out of scope for this review

Follow-up spec / backlog material, none blocking:

- **Instacart enablement package** (DG-1's disclosure string, the §5.5 probe demotion,
  the `instacart_retailer_key` role note) and **a store EDIT drawer for
  `stores.postal_code`** (DG-2).
- **Write-side URL validation** — rejecting non-`http(s)` in `advanceOrderApproval`'s
  `externalRef` mapping and `updateVendor`'s `order_page_url`. The open-side boundary is
  the exploitable one and is now closed; this is cheap defense-in-depth.
- **Security Lows:** brand→store scoping of `notifications` RLS (inherited from spec
  120, a separate spec by the auditor's own framing), fixed i18n string instead of raw
  PostgREST error text in-screen, ZIP/retailer-key format validation with a distinct 400,
  per-caller rate limiting on the edge function, and brand/submission provenance
  cross-checks in `create_order_approval`.
- **Architect Minors:** M-1 (three missing rows in the §5.3 error table), M-2 (stale-JWT
  asymmetry between `requireAdminCaller()` and `auth_is_privileged()` — fails closed,
  misleading diagnostic only), M-4 (a pgTAP arm whose description overstates its RLS
  coverage), M-7 (a one-line client-side precondition on MARK ORDERED).
- **Code-reviewer nits:** the silent 0-row `advanceOrderApproval` update, the pre-existing
  `fetchBreadbotSales` dead branch (already documented as known-latent), and splitting the
  260-line `instacart-cart-link` handler into named phases.
- **Test infrastructure:** `scripts/smoke-instacart-cart-link.sh` (AC-30) is manual and
  not wired into either gate — a green CI is not evidence AC-30 ran. Wiring
  `verify_jwt = false` / cron-invoked Deno functions into an automated track remains a
  repo-wide gap (the mirror pattern narrows it for pure logic only).
- **`report_reorder_list`-exact emit predicate** (the pg_net → engine → emit async job),
  per §3.3 and the architect's explicit "not sooner" ruling.

## Handoff
next_agent: NONE
prompt: SHIP_READY — 0 open Criticals; commit + push, then deploy web/functions and
  apply the 3 prod migrations via MCP before the db-migrations gate can re-green.
  Instacart channel ships dark behind 4 gates; DG-1 (retailer pinning) and DG-2
  (postal_code edit surface) are PM decisions that block channel enablement, not merge.
payload_paths:
  - specs/149-eod-approve-order-pipeline/reviews/release-proposal.md
