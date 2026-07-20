# Release proposal — combined feature: spec 131 (pending-PO order payload) + spec 132 (browser-extension cart-filler)

## Verdict
verdict: SHIP_READY
rationale: No reviewer across either spec flagged a Critical, every spec-131 blocking/Should-fix item from the prior FIXES_NEEDED proposal has landed and re-verified green, and spec 132 ships dry-run-default-ON with explicitly owner-iterated adapters — so the four spec-132 Should-fix items ride as fast-follows; the only remaining bar is the operational deploy sequence (two prod migrations pending) that MUST be executed in the exact order below so `db-migrations-applied.yml` returns green.

## Findings summary

**Spec 131 — backend contract (pending-PO payload + mark-ordered)**
- code-reviewer: 0 Critical, 3 Should-fix, 3 nits — ALL RESOLVED. (1) `product_page_url` editor field → owner ruled KEEP; (2) `apply_item_vendors_to_brand` non-propagation → fixed by new migration `20260724000000` + `db.ts`/`useStore` client threading; (3) missing M3 pgTAP header/coverage mismatch → M3 assertion implemented, `plan(18)→(19)`.
- security-auditor: 0 Critical / 0 High / 0 Medium, 2 Low (both cross-spec/informational). RPCs are SECURITY INVOKER + `search_path=public`, `auth_can_see_store`/`auth_can_see_brand`-bounded, grants revoke public/anon, no injection, no secrets, no permissive-policy pitfall. The one substantive Low (URL-scheme validation on `order_page_url`/`product_page_url`) is a spec-132 navigation concern (addressed below).
- test-engineer: no FAILED ACs. AC-6's blocking write-side RLS-denial gap is CLOSED (M3, `extension_ordering.test.sql` now `plan(19)`); AC-1/AC-2 round-trip caveat closed via new `VendorFormDrawer.test.tsx` describe block. Full suite green: `npx jest` 122 suites / 1322 tests; `npm run test:db` 75/75 files (`extension_ordering` 19/19, `apply_item_vendors_to_brand` 22/22).
- backend-architect (drift): 0 Critical drift, 1 Should-fix (S-1 — extension UPDATE must self-carry `and status='draft'`; handed to spec 132 and CONFIRMED landed there), 4 Minor. Migration-filename bump ruled ACCEPTABLE; KEEP on `product_page_url` with the "spec 132 must not re-build it" condition — honored (132 consumes the column, does not re-build the editor).

**Spec 132 — Chrome MV3 cart-filler**
- code-reviewer: 0 Critical, 4 Should-fix, 3 nits. Shared case-math (`computePoQuickOrderLines`) imported verbatim (no fork); guarded `markOrdered` (`... and status='draft'`) confirmed — this is exactly architect S-1 from spec 131; host_permissions scoped to the two vendor origins + injected Supabase origin (no `<all_urls>`); Expo-graph isolation correctly wired (tsconfig exclude, metro blocklist, jest ignore, own CI Track 1c). Four Should-fix are fast-follow candidates (see below).
- security-auditor: 0 Critical / 0 High, 1 Medium (dev-only — vitest/vite/esbuild devDependency CVEs never reach the shipped artifact), 4 Low. AC-9 hard boundary verified clean on all four legs (no checkout/pay path, no vendor-credential handling, no CAPTCHA circumvention, host-scoped). Anon-key-only auth, guarded RLS-bounded mark-ordered write, URL-scheme validation gates every navigation.
- test-engineer: no FAILED ACs. 10 PASS + 1 PASS-partial (AC-6 live cart-fill mechanics uncovered by design) + 1 NOT-TESTED (AC-11, owner-manual by design). 29 vitest cases green; the two "no automated CI guard" notes (AC-1/AC-9 static-config, AC-6 orchestration) are regression-protection follow-ups, not present-state defects.

**Cross-spec seam verified:** spec-131 architect S-1 (extension must not reuse the unguarded `markPurchaseOrderSent`) is satisfied — spec-132's `imrClient.markOrdered` issues the guarded `update ... set status='sent' where id=:poId AND status='draft'`, pgTAP-pinned at `extension_ordering.test.sql::(M1,M2,M3)`. Spec-131 security Low (URL-scheme validation) is satisfied — spec-132 validates http(s) via `isSafeHttpUrl` before every navigation.

## Spec-132 Should-fix items — disposition: FAST-FOLLOW, do not gate ship

None is Critical; the security Lows overlap two of them; the extension ships **dry-run-default-ON** (no cart mutation or mark-ordered write is reachable without the owner explicitly turning dry-run off) and the vendor adapters are in an **explicit owner-tune / AC-11 manual-verification loop**. That posture is why these do not block, but items 1-2 touch the AC-9 boundary and should lead the first owner-tune pass.

1. **Fragile challenge-string match** (`service-worker.ts:200`, `res.detail.startsWith('Challenge detected')`) — security Low + code Should-fix. The STOP still fires correctly today; the risk is a future copy edit silently downgrading a mid-run CAPTCHA hit. Replace with a structured `outcome:'challenge'`/`challenge:boolean` signal. Lead the fast-follow list (AC-9-adjacent).
2. **Fail-open `pageIsLoggedIn`** (`bjs.ts:59`/`samsclub.ts:57`, defaults logged-in) — security Low + code Should-fix. Security-auditor confirms worst case is a wasted add reported `failed`, not a security gap; but a fail-CLOSED default aligns with the AC-9 "stop and ask the human" posture. Fold into the owner-tune selector pass.
3. **Dropped `rounded` signal** (`plan.ts:49-68` discards `StructuredOrderLine.rounded`) — code Should-fix. Information loss against the project's "fail loud" convention; surface via report `detail` text. Fast-follow.
4. **Overloaded `'added'` label** (`adapters/types.ts` — search-pick vs. add-to-cart reuse the same enum value) — code Should-fix. Give the search-pick step its own value (`'resolved'`). Fast-follow.

Also fast-follow (test-engineer): a `manifest.test.ts` asserting the exact `host_permissions` array + a grep-based checkout/pay lint, to convert the AC-1/AC-9 human-inspection duty into a CI gate. Owner's AC-11 pass should include one deliberately-unmatched line to confirm per-item-continue orchestration.

## Recommended next steps (ordered) — commit + prod-apply sequence

The code is ship-ready. The only remaining bar is that TWO prod migrations are unapplied, so `db-migrations-applied.yml` on `main` reads RED the instant the repo migrations are pushed without a matching prod apply. Per CLAUDE.md, SHIP_READY cannot stand while either gate is red — so the deploy MUST run as one ordered operation, not "push now, apply later":

1. **Stage the combined 131+132 change** (working tree → staged). User runs the commit (per project policy, no agent auto-commit).
2. **Prod-apply migration `20260723000000_extension_ordering.sql` FIRST** via Supabase MCP `execute_sql` (project `ebwnovzzkwhsdxkpyjka`), then INSERT version `20260723000000` into `supabase_migrations.schema_migrations`. Verify: 3 additive columns present + 2 RPCs by normalized-md5.
3. **Prod-apply migration `20260724000000_apply_item_vendors_product_page_url.sql` SECOND** (it `CREATE OR REPLACE`s the spec-119 `apply_item_vendors_to_brand` RPC and depends on 20260723's `product_page_url` column existing), then INSERT version `20260724000000` into `schema_migrations`. Verify the RPC by normalized-md5. Ordering is load-bearing: 20260724 must not land before 20260723.
4. **Push `main`.** With both prod-applies done, the migration-drift gate has nothing missing.
5. **Confirm BOTH gates green on `main`** (mandatory post-push check): `gh run list --branch main --workflow test.yml --limit 1` AND `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`. The new extension Track 1c job runs inside `test.yml`. If either is red/in-progress, surface the run URL and hold. Only after both are green is the ship complete.
6. **(Fast-follows, not blocking)** Schedule the four spec-132 Should-fix items (lead with challenge-string signal + fail-closed login default) into the owner-tune iteration, plus the `manifest.test.ts`/checkout-grep CI guards.

## Out of scope for this review
- **Live vendor-site DOM behavior (AC-11)** — owner-manual by design; the adapters' `OWNER-TUNE ZONE` selectors get hand-verified in the tuning loop, not in CI.
- **Extension devDependency CVEs (vitest/vite/esbuild)** — dev/CI-machine only, never in the shipped bundle; bump deliberately (vitest@4 is a breaking major), not a deploy blocker.
- **Pre-existing `markPurchaseOrderSent` unguarded UPDATE / resurrection behavior** — spec-107 code, masked by client-side `canSend` gating; the extension correctly uses its own guarded write instead.
- **AC-5 zero-search-result label** (`'failed'` vs literal `'unmatched'`/`'ambiguous'`) — substance of AC-5 holds (surfaced, never silently guessed); one-line spec/architect clarification, follow-up.
- **`storageAdapter` unencrypted session token** — design-acknowledged D-2/D-10 tradeoff, standard extension posture (the admin's own JWT, no elevation).

## Handoff
next_agent: NONE
prompt: SHIP_READY (combined 131+132). No Critical in any of the 8 reviewer files; all spec-131 blocking items landed (M3 pgTAP plan(19), VendorFormDrawer round-trip tests, owner KEEP + apply_item_vendors_to_brand propagation via migration 20260724000000 + client threading); the four spec-132 Should-fix items ride as fast-follows given dry-run-default-ON + owner-iterated adapters. Ship is gated only on the ordered deploy: stage → commit → prod-apply 20260723000000 then 20260724000000 (order load-bearing) + insert both schema_migrations rows → push → confirm BOTH test.yml and db-migrations-applied.yml green on main. Do not push without prod-applying or db-migrations-applied.yml reads red.
payload_paths:
  - specs/132-browser-extension-cart-filler/reviews/release-proposal.md
