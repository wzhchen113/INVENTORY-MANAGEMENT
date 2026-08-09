# Release proposal — specs 155 + 156 (combined)

Covers **both** specs, which built in parallel in one staged tree on top of `74ffabe`:

- `specs/155-instacart-enablement.md` — Instacart channel enablement (store ZIP edit surface,
  picker disclosure, retailer probe demoted to advisory, go-live runbook).
- `specs/156-export-order-recording.md` — record quick-order / CSV / PDF exports as draft orders.

Reviewer files read in full (7): `specs/155-instacart-enablement/reviews/{code-reviewer,
security-auditor,test-engineer,backend-architect}.md` and
`specs/156-export-order-recording/reviews/{code-reviewer,security-auditor,test-engineer}.md`,
plus spec 155 §"Post-review fix round #1 — backend" and spec 156 §"Post-review round 1 —
security-auditor Mediums 1 + 2".

## Verdict

verdict: SHIP_READY
rationale: Zero Criticals across all seven reviews, every Should-fix in both specs is closed
(or explicitly closed by live verification), all 46 acceptance criteria PASS, and the full gate
set is green — the only remaining items are documented non-blocking Minors/Lows.

## Findings summary

### Spec 155 — Instacart enablement

- **code-reviewer**: 0 Critical, 1 Should-fix, 2 Nits.
  The Should-fix was AC-12's unverified live layout (two-line disclosure at 390px, dark theme,
  EDIT drawer at phone width) — **CLOSED** by a live 390×844 both-themes pass through the real
  notification deep-link: no scroll, no clipping, screenshots on file. Nits (unconditional
  "● unsaved" badge now reading oddly in EDIT mode; duplicate Zustand selectors across the two
  drawer instances) are both flagged by the reviewer as pre-existing/out-of-scope.
- **security-auditor**: 0 Critical, 0 High, 0 Medium, 3 Low. No blocker. Lows: `stores.postal_code`
  has no server-side CHECK (client-only validator, but the one server consumer wraps it in
  `encodeURIComponent` — no SSRF/injection path); an RLS 0-row PATCH still toasts success before the
  re-read snaps the row back (architect-designed reconciliation, AC-7); the new `onEditSaved` error
  path surfaces a raw PostgREST message — a byte-for-byte copy of the pre-existing handler beside it.
  Positively verified: no key/ZIP/retailer-key/URL in any log line, blank-key 409 `reason` leaks
  nothing, `brandId` cannot be smuggled through the widened `updateStore` (three independent layers),
  `verify_jwt = true` and `ADMIN_ROLES` include `super_admin`.
- **backend-architect** (post-impl drift): **no Critical drift, "the contract landed"**; 4 Should-fix,
  6 Minor. Status after the fix round, spot-checked in the staged tree:
  - **S1 fixed** — runbook now has an unconditional step **1b** "Deploy the spec-155 function build"
    (`spec:381`) plus verification step 5.10 reading a 409-shaped fallback as deploy skew (`spec:460`).
  - **S2 fixed** — smoke fixture-hygiene banner, `is_reused()` + shared reuse hint so arms 7-11 SKIP
    on a consumed fixture, `PROBE_FAIL_APPROVAL_ID` no longer defaults to the arm-3-consumed
    `APPROVAL_ID`, arm 10 self-skips instead of `note`, and a new stalled-body **arm 11**.
  - **S3 fixed** (by dispatcher) — the frozen AC-18 branch's comments now name the blank-key cause
    (`src/store/useStore.ts:3799-3805`); behaviour and pins untouched.
  - **S4 fixed** — `idpFetch` now returns `{ res, json(), done() }` with the abort deadline covering
    the **body** read on both paths (`UpstreamParseError` + `isAbortError()`,
    `supabase/functions/instacart-cart-link/index.ts:200-261`); verified live at 3 s (probe) and
    10 s (`products_link`) against a stalling stub.
  - **M1/M2 done** (`advisory=<token|none>` on the terminal log line; `cause=timeout|parse|network`
    on the probe failure line). **M3/M4/M6 remain open as non-blocking minors**; M5 is spec-internal
    wording already annotated as resolved.
  - Architect rulings R1-R7 all landed as designed, including the unparseable-probe-body judgment
    call (endorsed as design-consistent) and the `onSaved` refresh placement (judged *better* than the
    design's own pseudo-code).
- **test-engineer**: **24/24 ACs PASS**, no unverified AC. Both review caveats are now closed —
  the shell smoke (AC-24, static-only at review time) was run **live** in the fix round against a
  local IDP stub with every arm exercised, and the live-browser gap is closed by the 390×844 pass.
  Frozen suites confirmed byte-identical: `StoresTab.toggle.test.tsx`, `orderChannel.test.ts`,
  `vendor_order_channel.test.sql` (11 assertions), `order_approvals.test.sql` (24 assertions).

### Spec 156 — Export order recording

- **security-auditor**: 0 Critical, 0 High, **2 Medium (both FIXED)**, 2 Low.
  Both Mediums shared one root cause — the write key was derived from *live* global state read
  after the async gap the export itself introduces (user-paced share sheet, `jspdf` dynamic
  imports). M1: a mid-export store switch would file store A's item ids, quantities and costs under
  `store_id = B`. M2: the draft's own realtime echo nulls `reorderPayload`, so a second in-flight
  export recorded with `referenceDate = undefined` → a **second** undated draft header that D-4's
  key could not collapse and `has_po` could not see. Fixed by one mechanism: an export-start
  snapshot of `{ storeId, referenceDate }` passed as `ExportRecordingContext`, with a **reported**
  refuse-on-mismatch (`'Active store changed during the export — not recorded'`,
  `src/store/useStore.ts:3636-3640`) and a D-4 key that is non-empty by construction
  (`useStore.ts:3668`). **11 new pins**, including the end-to-end Medium-2 echo-collapse chain
  (export #1 in flight → echo nulls the payload → export #2 resolves → exactly ONE write).
  Low 1 (silent `.catch`) fixed alongside the code-reviewer's Should-fix; Low 2
  (`notifyBackendError` rendering `e.message`) is inherited house convention with no store/vendor/
  user/item/qty/cost interpolated — recorded, no action.
- **code-reviewer**: 0 Critical, 1 Should-fix, 2 Nits. The Should-fix (six `.catch(() => {})` that
  swallowed a contract violation with zero signal) is **APPLIED at all six sites** — verified:
  `ReorderSection.tsx:421,517,527` and `PhoneOrdering.tsx:620,647,662` all now
  `console.warn('[spec156] recordExportedOrder rejected (contract violation):', e)`. The
  `void … ?.(…).catch(…)` **deviation is adjudicated ACCEPT** (forced by AC-REG-1's three frozen
  mocks plus the design's own no-unhandled-rejection test; optional-chaining short-circuit and
  run-to-completion ordering verified). The ★ spec-104 `costPerUnit × subUnitSize` bridge survives
  the `buildDraftOrderLines` extraction and is pinned by an executable parity test driven through
  the real `fillCartForVendor`. Nits: a JSDoc addendum at the interface entry, and a stale literal
  snippet in the design doc's §D-3 (the deviation is documented in the spec, so not hidden drift).
- **test-engineer**: **22/22 ACs PASS** plus the full AC-REG group; 48 new tests (26 + 13 + 9),
  now 59 with the security round's 11. Cross-spec attribution done file-by-file via `git diff`, not
  assumed — every shared-file edit (`db.ts`, `useStore.approveOrder.spec149.test.ts`, the three i18n
  catalogs, everything under `supabase/**`) is attributed to spec 155, confirming 156's frontend-only
  and no-`db.ts`-change claims. AC-18 re-verified at source: `tg_notify_purchase_order` guards on
  `'sent'`/`'partial'`/`'received'`, so a `draft` INSERT fires no notification. The live-browser item
  was flagged "pending manual evidence" — **now PASSED**: three exports produced exactly one draft PO
  with byte-matching lines, and ORDER HISTORY shows it.
- **backend-architect**: not invoked for 156 (frontend-only spec, no backend surface). Spec 155's
  architect explicitly closed the one cross-spec coordination item: 156 amended AC-REG-4 to freeze
  the channel→disclosure-key *behaviour* rather than the outgoing `disclosureKeyForChannel` symbol,
  so there is no phantom regression between the two specs.

### Gates (both specs, one tree)

- `npx tsc --noEmit` — clean. `npm run typecheck:test` — clean (the CI gate jest alone misses).
- `npx jest` — **201 suites / 2193 tests green**.
- `npm run test:db` — **80/80 pgTAP files pass**, untouched (no DB change ships).
- Shell smoke — run **live** against the local stack + IDP stub; all arms including new arm 11.
- CI on `main` green at `74ffabe` (spec-154 state) for both `test.yml` and
  `db-migrations-applied.yml`. **Neither spec ships a migration**, so the migration gate is inert
  for this changeset — but per CLAUDE.md both gates must still be re-confirmed green after the push.

## Recommended next steps (ordered)

1. **Commit the staged tree** (agents do not auto-commit; this is your call). One commit covering
   both specs is appropriate — they are interleaved in `src/store/useStore.ts` in disjoint hunks and
   were gated together.
2. **Push to `main`**, then confirm **both** gates green before anything else:
   - `gh run list --branch main --workflow test.yml --limit 1`
   - `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`

   If either is red or in-progress, stop and surface the run URL. The migration gate should be a
   no-op here (empty `supabase/migrations/` diff); a red one would mean SQL escaped scope.
3. **Vercel** picks up the web bundle from `main` automatically. At this point **spec 156 is fully
   live** — it needs no other deploy step and no configuration.
4. **Deploy the edge function — REQUIRED, do not skip** (runbook step 1b):

   `npx supabase functions deploy instacart-cart-link --project-ref ebwnovzzkwhsdxkpyjka`

   This is the one deploy action beyond Vercel. Skew is **silent by construction**: an un-redeployed
   function keeps returning the pre-155 `409 retailer_unavailable`, which the preserved AC-18 client
   branch absorbs into an info toast plus a channel fallback — the operator just sees "Instacart
   didn't happen" with no error to trace. No migration, no `config.toml` change, and **no**
   `docker restart supabase_realtime_imr-inventory`.
5. **Verify the deploy landed** — runbook step 5.10: a 409-shaped fallback after step 1b means the
   deploy did not take. Re-run step 1b.
6. **Instacart go-live stays owner-gated and is not part of this ship.** The runbook's remaining
   steps require the owner to obtain `INSTACART_IDP_API_KEY`, set + verify the secret (note: a secret
   set before step 1b only reaches the running function after it), enter store ZIPs, discover
   retailer keys, and opt in per vendor. Until then the feature is inert and safe — which is by
   design, not an omission.
7. *(Optional, when convenient)* Re-run `scripts/smoke-instacart-cart-link.sh` against prod-adjacent
   fixtures. Note the fix round's own hygiene rule: arms 7-11 each need a **fresh** approval per run,
   and will now SKIP with an actionable reason rather than fail misleadingly on a consumed fixture.

## Out of scope for this review

Non-blocking follow-ups. None of these gate the ship; each wants its own spec or a hygiene pass.

- **Spec 155 open Minors** — M3 (`onEditSaved`'s `refresh()` has no stale/cancel guard, unlike the
  mount effect beside it), M4 (the two advisory unions are mirrors with only a one-way pointer;
  `db.ts` should point back at the edge function), M6 (nothing enforces mutual exclusion of the two
  simultaneously-mounted `StoreFormDrawer` instances — zero cost today, worth a guard the day the
  layout moves).
- **`stores.postal_code` server-side validation** — a `check (postal_code is null or postal_code ~
  '^\d{5}(-\d{4})?$')`. Defense in depth only; the auditor explicitly judged it not worth a
  prod-apply + `db-migrations-applied` cycle on its own.
- **0-row PATCH honesty** — a `.select('id')`-returning PATCH in `db.updateStore` so an RLS 0-row
  write is distinguishable from a real one, rather than relying on the re-read to snap back.
- **Error-message hygiene pass** — `BrandsSection.tsx` surfaces raw PostgREST messages in two
  places now (the pre-existing mount handler and the new `onEditSaved` handler); fix both together.
- **The "● unsaved" drawer badge** is unconditional — accurate in CREATE mode, misleading the moment
  the EDIT drawer opens on unmodified data.
- **Spec 156 OQ-4 provenance marker** — for an `extension_ordering` vendor, an export-recorded draft
  also appears in the extension's pending list. This is the design's named, accepted residual; the
  provenance marker is the recommended follow-up spec.
- **Design-doc amendments** — spec 156 §D-3's literal call-site snippet is stale relative to the
  shipped shape (documented in the deviation note, so not hidden drift); spec 155 §12 still assigns
  `db.ts` §8 to the backend-developer (annotated as resolved).
- **Pre-existing observation, unrelated to both specs** — the Ordering surface can mount into a blank
  state that requires a manual REFRESH. Not introduced here; worth its own spec.
- **Release-note items carried forward (behaviour, not bugs)** — the reorder list blanks and refetches
  ~400 ms after every export (realtime self-echo nulls `reorderPayload`; same as FILL CART, just more
  frequent), and an export recorded today only surfaces in spec 151's context line on the **next**
  ordering cycle, because 151 anchors strictly before the viewed date.

## Handoff

next_agent: NONE
prompt: SHIP_READY
payload_paths:
  - specs/156-export-order-recording/reviews/release-proposal.md
