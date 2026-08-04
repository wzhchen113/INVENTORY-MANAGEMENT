# Release proposal — specs 150 + 151 (combined)

Covers both specs, which are staged together in one working tree:

- `specs/150-active-brand-store-switch-strand.md` — active-brand / store-switch
  strand fix (frontend only, no migration).
- `specs/151-last-order-context.md` — last-order context on count and ordering
  rows (new `report_last_order_context` RPC + both render tiers).

Reviewer files read in full: `specs/150-active-brand-store-switch-strand/reviews/{code-reviewer,security-auditor,test-engineer}.md`
and `specs/151-last-order-context/reviews/{code-reviewer,security-auditor,test-engineer,backend-architect}.md`,
plus the two fix-round sections in the spec-151 file (frontend §1605-1676,
backend §1775-1907).

## Verdict

verdict: SHIP_READY
rationale: No reviewer flagged a Critical on either spec, every Should-fix /
Medium / PARTIAL raised against spec 151 has a fix I verified present in the
staged tree, and both CI gates on `main` are currently green — the only
remaining work is the owner-gated prod migration apply and one optional product
decision.

## Findings summary

### Spec 150

- **code-reviewer** — 0 Critical, 0 Should-fix, 3 Nits. Verified the shared
  `visibleStoresFor` predicate is genuinely one function (no residual inline
  copies), the module-placement cycle rationale is correct, and the additive
  `setCurrentBrandId` return breaks none of the four call sites. Nits: the
  "brand stranded" guard is written out twice (`useStore.ts:1095-1101` vs
  `:1179-1183`); `login()`'s `fetchStores().catch` path deliberately skips
  `reconcileActiveBrand` and should say so; the four-deep `||` fallback chain in
  the login tail is hard to scan.
- **security-auditor** — 0 Critical, 0 High, 0 Medium, 2 Low + 1 informational.
  The refactor is strict-equivalence on the two chrome consumers and a
  *tightening* inside the store (the brand-switch pick previously had no
  per-user filter); RLS untouched, `currentBrandId` never reaches the backend,
  no injection sink for the new `{brand}` interpolation. Lows are both
  pre-existing: the login-tail `allStores[0]` arm can name an ungranted store
  from a stale in-memory list on a shared browser (cosmetic — every store-scoped
  read stays RLS-blocked), and the `currentUser === null` brand-switch branch
  keeps the legacy unfiltered pick (unreachable behind `useIsSuperAdmin()`).
  Informational: `auth_can_see_store()` short-circuits on `auth_is_admin()` with
  no brand scoping while `brands` SELECT *is* brand-scoped — a DB-side question,
  not introduced here.
- **test-engineer** — AC-1 … AC-8 + AC-REG all **PASS**, each mapped to a named
  test. Gates green at that pass (184 suites / 1847 tests, tsc + typecheck:test
  clean); i18n parity is machine-checked, not eyeballed. One non-blocking gap: no
  non-privileged role drives the cold-start `reconcileActiveBrand` path
  end-to-end through `login()` (both primitives are independently pinned and
  `reconcileActiveBrand` has no role-conditional logic of its own). One
  documentation nit: the spec undercounts new `PhoneStoreSwitch` cases by 2 —
  actual coverage exceeds the claim. The browser manual-QA section was not
  re-run by the reviewer.

### Spec 151

- **code-reviewer** — 0 Critical, 1 Should-fix, 2 Nits. Calls the
  implementation "unusually faithful"; the AC-10 honesty rule is enforced at
  three independent layers and AC-14's single insertion point is proven
  structurally (`PhoneApproveOrder.tsx` zero-diff + `describe.each` over both
  screens). **SF (FIXED)** — the desktop AC-9 "NO PRIOR ORDER ON RECORD" line
  sat inside the collapse-gated footer while desktop cards default to collapsed.
  Verified fixed: the line now renders inside the always-visible stats row
  (`ReorderSection.tsx:750` `reorder-vendor-stats-*` → `:781`
  `reorder-last-order-none-*`), mirroring the phone tier. Nit (FIXED) — the
  redundant second Zustand selector is gone. Nit (OPEN, out of scope) —
  `sum(coalesce(pit.ordered_qty, 0))` would render "ORDERED 0" rather than a gap
  for a genuinely-NULL `ordered_qty`; matches the design and every current write
  path.
- **security-auditor** — 0 Critical, 0 High, **1 Medium**, 2 Low, with live
  local-stack verification (pgTAP, `prosecdef`, grants, PostgREST probes).
  **Medium (FIXED)** — the AC-22 vendor bound used `array_length(p_vendor_ids, 1)`
  (first dimension only) while `unnest` flattens everything, so a nested array
  carried 100 000 ids past the check; demonstrated end-to-end, not theoretical.
  Verified fixed: `migration:86` now reads `cardinality(p_vendor_ids)`, and
  pgTAP arm **(B5)** (`report_last_order_context.test.sql:711`) refuses a nested
  2 × 51 array with `22023`. Low (FIXED) — `logout()` now clears
  `lastOrderContext` (`useStore.ts:1068`). Low (ACCEPTED, operational) — the
  non-concurrent `create index` takes a `SHARE` lock on `eod_entries`; a
  PROD-APPLY LOCK NOTE now sits beside the statement (`migration:391`). Verified
  clean: invoker posture + `42501` top gate, no privilege escalation across the
  union, cross-store isolation with no existence oracle, least-privilege grants,
  no injection surface, no secrets/PII, AC-24 call-path discipline.
- **backend-architect** (post-impl drift) — no Critical, **3 Should-fix**,
  2 Minor. Contract conformance table is fully green (signature, envelope,
  invoker gate, tier precedence, null-preservation, single phone insertion
  point, no publication change). All five are verified fixed:
  - **SF-1 (FIXED)** unguarded `(l->>'item_id')::uuid` cast — one malformed
    `lines[]` element would `22P02` the whole store's envelope. Now guarded by a
    uuid-shape regex (`migration:244`); arms **(G1)/(G2)** assert the sibling
    line still resolves and the malformed element contributes no row, and the
    malformed vendor sits in the MAIN `_ctx` call so a regression takes the file
    down.
  - **SF-2 (FIXED)** the (P1) arm re-implemented the spec-053 lint detector in
    its pre-arm-4 form and had already drifted. Deleted rather than repaired;
    replaced by **(P1a)/(P1b)** — the five source tables carry exactly their
    expected named SELECT policies and every qual still routes through
    `auth_can_see_store` (plus `auth_is_privileged` on `order_approvals`). This
    is the stronger pin: under `security invoker` those policies *are* the
    function's entire authorization story.
  - **SF-3 (FIXED)** `counted_lines` fan-out from un-deduped `eod_entries`. Now
    `distinct on (cs.vendor_id, e.item_id) … order by cs.vendor_id, e.item_id,
    e.created_at desc, e.id desc` (`migration:271-278`) — last-written-wins, not
    `sum()`, per the architect's AC-10 reasoning. Arms **(D1)/(D2)** pin one
    element and the last-written value `9`, never the summed `12`.
  - **M-1 (FIXED, comment-only)** the "realtime replay does not refetch" claim
    was false; the comment and the test title now state the narrower truth.
  - **M-2 (FIXED)** a new runtime-harvested jest case asserts all nine i18n keys
    resolve to non-empty strings in en/es/zh-CN via a direct dot-path walk (not
    `t()`, which would fall back to English and hide a missing locale).
- **test-engineer** — 29 acceptance criteria, all **PASS** except **AC-22
  PARTIAL**: the per-vendor 500-item cap had no real SQL fixture, only a jest
  mapper test fed a hand-supplied boolean. Verified fixed with a genuine 501-item
  fixture: **(U1)** `jsonb_array_length(items) = 500` + `items_truncated = true`,
  **(U2)** the dropped element is rank 501 (lowest qty), **(U3)** rank 500 is
  retained. Two remaining notes are verification ceilings, not gaps: AC-16's
  layout-only claims (RN Testing Library has no layout engine — the same ceiling
  every phone a11y-bar spec in this repo hits), and the CI-gates-after-push rule
  which only engages once the work is actually pushed.

### Judgment call requested: the `e.id desc` tiebreak deviation

The backend fix round added `e.id desc` as a final tiebreak beyond the
architect's stated ORDER BY, and flagged it explicitly. **Accept as-is.** It
strictly narrows nondeterminism (two duplicate entries sharing `created_at`
would otherwise return an arbitrary row), is behaviour-neutral wherever
`created_at` differs, and — critically — it does not violate the constraint the
architect actually cared about: it still picks one real staff-entered value
rather than inventing a sum. No rework needed.

### Gates (re-run by the fix agents, and consistent across all four reviewers)

```
npx tsc --noEmit          clean
npm run typecheck:test    clean
npx jest                  189 suites / 1929 tests green
npm run test:db           80/80 files green (report_last_order_context: 41/41)
npx expo export --web     clean
```

`plan(41)` confirmed in the pgTAP file; every fix-round arm (B5, D1, D2, G1, G2,
U1, U2, U3, P1a, P1b) is present. CI on `main` is green at the spec-149 state
(nothing pushed since).

## Recommended next steps (ordered)

1. **Commit both specs together** (they share a working tree and `useStore.ts`
   hunks; splitting them would require unpicking interleaved edits for no
   benefit). Owner runs the commit — nothing has been committed.
2. **Apply migration `20260803000000` to prod via the MCP path BEFORE pushing**,
   if the ordering is convenient. Rationale: the Vercel deploy fires on push, and
   an FE that calls a not-yet-existing RPC degrades to silent no-context
   (AC-17 — correct, but it means the feature ships dark). Applying first also
   shrinks the `db-migrations-applied.yml` red window to zero. If you'd rather
   push first, that is acceptable — the gate going red in between is **expected
   per R-1, not a drift bug**; do not "fix" it.
   - Follow MEMORY `project_prod_migration_via_mcp`: `execute_sql` the migration,
     insert the exact version `20260803000000` into
     `supabase_migrations.schema_migrations`, verify the function with a
     normalized-md5 comparison (project `ebwnovzzkwhsdxkpyjka`).
   - **Heed the PROD-APPLY LOCK NOTE** at `migration:391`. Check
     `public.eod_entries`' prod row count first. If it is large, run the
     `create index if not exists idx_eod_entries_submission_id` statement
     separately as `create index concurrently`, OUTSIDE the transaction —
     otherwise the `SHARE` lock blocks staff EOD writes for the build duration.
     Apply off-peak either way.
3. **Push, then confirm BOTH gates on `main` are green** —
   `gh run list --branch main --workflow test.yml --limit 1` and
   `--workflow db-migrations-applied.yml --limit 1`. Per CLAUDE.md a green
   `test.yml` alone is not sufficient evidence. If step 2 ran before the push,
   both should be green on the first run; if it ran after, re-check
   `db-migrations-applied.yml` once the prod apply completes.
4. **Decide R-2 (product, not engineering).** Tier currently dominates recency:
   a `sent` PO from six weeks ago outranks a `draft` PO from yesterday, so the
   owner may see `LAST JUN 18` when a cart was filled last Wednesday. This IS
   what AC-2 specifies and it is pinned by pgTAP (A1-A4), but the owner has not
   seen it rendered yet. The alternative is a one-line ORDER BY flip plus the
   matching pgTAP update — cheap to change after a week of real use. **Not
   blocking; ship on the current confirmation-first behaviour and revisit.**
5. **Optional visual pass.** Neither fix round had `preview_*` tooling
   available, so the desktop collapsed-first-paint AC-9 placement is proven by a
   component test against the real store + real i18n catalog + a structural
   `reorder-vendor-stats-*` assertion, plus a clean web export — not by a
   screenshot. Both fix agents stated this plainly rather than claiming a visual
   pass. A 60-second look at a collapsed desktop vendor card and a phone
   ordering row after deploy would close it.

## Out of scope for this review

Each belongs in its own spec or a later cleanup pass; none blocks this ship.

- **`eod_entries` uniqueness + `report_reorder_list` hardening** (architect
  SF-3 tail). `eod_entries` has no unique constraint on
  `(submission_id, item_id)` and both writers delete-then-insert from a
  client-supplied array. Spec 151 fixed the fan-out *inside its own RPC*; the
  shipped `report_reorder_list` still carries the identical un-deduped
  `left join`. The schema constraint needs a prod dedupe pass first — explicitly
  a follow-up spec per the architect, not something to smuggle into a display
  feature.
- **Clearing the whole reorder group on `logout()`** (security-auditor 151 Low,
  partially done). `lastOrderContext` is now cleared; `reorderPayload` and
  `orderSubmissions` still are not. Pre-existing; do the group in one pass.
- **Brand-scoping `auth_can_see_store()`** (security-auditor 150 informational).
  A brand-X admin can read brand-Y `stores` rows (name/address) even though
  `brands` SELECT is brand-scoped. Pre-existing and DB-side; flagged because
  spec 150 canonicalises the *client* mirror of that rule and a future reader
  might read `storeVisibility.ts`'s doc comment as evidence the DB is scoped.
- **Spec 150's login-tail defensive fallback** — dropping the bare
  `allStores[0]` arm now that `visible[0]` exists, and/or clearing `stores` in
  `logout()`. Verbatim-preserved pre-existing behaviour.
- **Spec 150 test gap** — one case for a non-privileged user cold-booting
  through `login()` with a stale cached brand whose stores exist but aren't
  granted (test-engineer named the exact fixture to add).
- **Spec 150 nits** — an `isBrandStranded()` helper to de-duplicate the strand
  guard; a comment on the `fetchStores().catch` asymmetry; splitting the
  four-deep `||` fallback chain.
- **Spec 151 nit** — a defensive pgTAP case for a `po_items` row with a
  genuinely-NULL `ordered_qty`, turning the current
  `sum(coalesce(pit.ordered_qty, 0))` behaviour into an explicit tested claim.
- **AC-16 layout assertions** — verifying flex sizing / no-horizontal-scroll
  executably would need a layout engine in the RN test setup; a repo-wide
  tooling question, not a spec-151 gap.

## Handoff

next_agent: NONE
prompt: SHIP_READY — specs 150 + 151, 0 Criticals across all seven reviewer
files, every Should-fix/Medium/PARTIAL verified fixed in the staged tree. Owner
commits; then apply migration 20260803000000 to prod via MCP (heed the index
lock note — consider `create index concurrently` off-peak), push, and confirm
both `test.yml` and `db-migrations-applied.yml` are green on `main`. One open
product option (R-2 recency-vs-confirmation anchor ordering) is a one-line flip,
not a blocker.
payload_paths:
  - specs/151-last-order-context/reviews/release-proposal.md
